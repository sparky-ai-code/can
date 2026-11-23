/*
 * canit: PID 1 and the host agent of a canos guest. One file, no dependencies beyond libc.
 *
 *   As PID 1 it mounts the pseudo filesystems, brings up the loopback interface, finds the virtio-serial port named
 *   "can.agent" and serves the host on it.
 *   `canit --stdio` serves one host on stdin and stdout instead. The tests use it; it does no init work.
 *
 * Wire format: src/vm/guest-protocol.js is the other half, and the two are tested against each other.
 *   frame = u32le length | u8 type | u32le id | payload     (length counts type, id and payload)
 *   a reply has the request's id and type | 0x80; ERROR (0xff) answers a request that failed.
 *   HELLO 0x01   -> payload "canit <version>\0<arch>\0"
 *   PING  0x02   -> the same payload
 *   EXEC  0x10   u32le timeoutMs | cwd\0 | argv0\0 argv1\0 ...  -> i32le exit | u8 timedOut | u32le outLen | u32le errLen | out | err
 *   POWEROFF 0x20 -> empty reply, then the machine powers off (or the process exits, in --stdio mode)
 *   WRITE 0x30   u32le mode | path\0 | data  -> empty reply. Creates or replaces the file; its folder must exist.
 *   READ  0x31   path\0  -> the file's bytes. A folder, or a file larger than one frame, is an error.
 *   SPAWN 0x40   cwd\0 argv0\0 argv1\0 ...  -> u32le program id. The program runs in the background; its output is kept.
 *   LOGS  0x41   u32le id | u8 stream (1 out, 2 err)  -> the kept output: the last 256 KB of that stream.
 *   STATUS 0x42  u32le id  -> u8 running | i32le exit code (0 while it runs).
 *   KILL  0x43   u32le id | i32le signal  -> empty. An ERROR if the program has already exited.
 *   PS    0x44   -> u32le count, then per program: u32le id | u8 running | i32le code | u32le len | command.
 *   STDIN 0x45   u32le id | data  -> empty. Writes to the program's stdin; blocks while the program is not reading.
 *   END_STDIN 0x46  u32le id  -> empty. Closes the program's stdin, so it sees end of input.
 * Background programs share the agent with exec. At most 64 at once. While an EXEC runs, background output waits in
 * its pipes, so a program that writes a lot then blocks until the next request is served.
 *
 * Known limits of this first version, kept on purpose:
 *   - one request at a time: an EXEC blocks the agent until the command ends (concurrent exec, spawn, files, ports are next);
 *   - no network setup yet (the distro's init step will bring up eth0);
 *   - output of a command is capped at OUTPUT_CAP bytes per stream; the rest is read and dropped.
 * The PID 1 path can only be tested by booting a guest; --stdio is tested on any Linux.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define VERSION "0.1"
#define MAX_FRAME (16u * 1024u * 1024u)
#define OUTPUT_CAP (1024u * 1024u)
#define AGENT_PORT "can.agent"

enum {
  T_HELLO = 0x01, T_PING = 0x02, T_EXEC = 0x10, T_POWEROFF = 0x20, T_WRITE = 0x30, T_READ = 0x31,
  T_SPAWN = 0x40, T_LOGS = 0x41, T_STATUS = 0x42, T_KILL = 0x43, T_PS = 0x44, T_STDIN = 0x45, T_END_STDIN = 0x46,
  T_REPLY = 0x80, T_ERROR = 0xff
};

static int in_fd = 0, out_fd = 1;
static int is_init = 0;

static void put_u32(uint8_t *p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }
static uint32_t get_u32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }

static int write_full(int fd, const void *buf, size_t n) {
  const uint8_t *p = buf;
  while (n) {
    ssize_t w = write(fd, p, n);
    if (w < 0) { if (errno == EINTR) continue; return -1; }
    p += w; n -= (size_t)w;
  }
  return 0;
}

/* 1 = got n bytes, 0 = end of input before the first byte, -1 = error or end in the middle. */
static int read_full(int fd, void *buf, size_t n) {
  uint8_t *p = buf;
  size_t got = 0;
  while (got < n) {
    ssize_t r = read(fd, p + got, n - got);
    if (r < 0) { if (errno == EINTR) continue; return -1; }
    if (r == 0) return got == 0 ? 0 : -1;
    got += (size_t)r;
  }
  return 1;
}

static int send_frame(uint8_t type, uint32_t id, const void *payload, uint32_t len) {
  uint8_t head[9];
  put_u32(head, 5 + len);
  head[4] = type;
  put_u32(head + 5, id);
  if (write_full(out_fd, head, sizeof head) < 0) return -1;
  return len ? write_full(out_fd, payload, len) : 0;
}

static int send_error(uint32_t id, const char *msg) { return send_frame(T_ERROR, id, msg, (uint32_t)strlen(msg)); }

static uint64_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
}

/* ---- EXEC ---- */

typedef struct { uint8_t *data; size_t len; } buf_t;

static void buf_add(buf_t *b, const uint8_t *src, size_t n) {
  if (b->len >= OUTPUT_CAP) return; /* keep reading, drop the rest */
  if (n > OUTPUT_CAP - b->len) n = OUTPUT_CAP - b->len;
  uint8_t *grown = realloc(b->data, b->len + n);
  if (!grown) return;
  memcpy(grown + b->len, src, n);
  b->data = grown;
  b->len += n;
}

static void do_exec(uint32_t id, const uint8_t *payload, uint32_t len) {
  if (len < 5) { send_error(id, "exec: payload is too short"); return; }
  uint32_t timeout_ms = get_u32(payload);
  const char *p = (const char *)payload + 4, *end = (const char *)payload + len;
  if (end[-1] != '\0') { send_error(id, "exec: strings are not NUL terminated"); return; }
  const char *cwd = p;
  p += strlen(p) + 1;
  size_t argc = 0;
  for (const char *q = p; q < end; q += strlen(q) + 1) argc++;
  if (argc == 0) { send_error(id, "exec: no command"); return; }
  char **argv = calloc(argc + 1, sizeof *argv);
  if (!argv) { send_error(id, "exec: out of memory"); return; }
  size_t i = 0;
  for (const char *q = p; q < end; q += strlen(q) + 1) argv[i++] = (char *)q;

  int po[2], pe[2];
  if (pipe(po) < 0 || pipe(pe) < 0) { free(argv); send_error(id, "exec: pipe failed"); return; }
  pid_t pid = fork();
  if (pid < 0) { free(argv); send_error(id, "exec: fork failed"); return; }
  if (pid == 0) {
    signal(SIGPIPE, SIG_DFL); /* the agent ignores SIGPIPE; a program must not inherit that */
    int dn = open("/dev/null", O_RDONLY);
    if (dn >= 0) { dup2(dn, 0); close(dn); }
    dup2(po[1], 1); dup2(pe[1], 2);
    close(po[0]); close(po[1]); close(pe[0]); close(pe[1]);
    if (in_fd > 2) close(in_fd);
    if (out_fd > 2) close(out_fd);
    if (cwd[0] && chdir(cwd) < 0) { dprintf(2, "canit: cannot chdir to %s: %s\n", cwd, strerror(errno)); _exit(126); }
    execvp(argv[0], argv);
    dprintf(2, "canit: cannot run %s: %s\n", argv[0], strerror(errno));
    _exit(errno == ENOENT ? 127 : 126);
  }
  close(po[1]); close(pe[1]);
  buf_t out = {0}, err = {0};
  struct pollfd fds[2] = {{po[0], POLLIN, 0}, {pe[0], POLLIN, 0}};
  uint64_t deadline = timeout_ms ? now_ms() + timeout_ms : 0;
  int timed_out = 0, open_fds = 2;
  uint8_t chunk[16384];
  while (open_fds > 0) {
    int wait_ms = -1;
    if (deadline) {
      uint64_t t = now_ms();
      if (t >= deadline) { timed_out = 1; kill(pid, SIGKILL); break; }
      wait_ms = (int)(deadline - t);
    }
    int r = poll(fds, 2, wait_ms);
    if (r < 0 && errno == EINTR) continue;
    if (r < 0) break;
    for (int k = 0; k < 2; k++) {
      if (fds[k].fd < 0 || !(fds[k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
      ssize_t n = read(fds[k].fd, chunk, sizeof chunk);
      if (n > 0) buf_add(k == 0 ? &out : &err, chunk, (size_t)n);
      else if (n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN)) { close(fds[k].fd); fds[k].fd = -1; open_fds--; }
    }
  }
  for (int k = 0; k < 2; k++) if (fds[k].fd >= 0) close(fds[k].fd);
  if (timed_out) kill(pid, SIGKILL);
  int status = 0;
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
  int32_t code = timed_out ? 124 : WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 1;

  uint8_t head[13];
  put_u32(head, (uint32_t)code);
  head[4] = (uint8_t)timed_out;
  put_u32(head + 5, (uint32_t)out.len);
  put_u32(head + 9, (uint32_t)err.len);
  uint32_t total = (uint32_t)(sizeof head + out.len + err.len);
  uint8_t fh[9];
  put_u32(fh, 5 + total); fh[4] = T_EXEC | T_REPLY; put_u32(fh + 5, id);
  write_full(out_fd, fh, sizeof fh);
  write_full(out_fd, head, sizeof head);
  if (out.len) write_full(out_fd, out.data, out.len);
  if (err.len) write_full(out_fd, err.data, err.len);
  free(out.data); free(err.data); free(argv);
}

/* ---- serving ---- */

/* ---- files ---- */

/* WRITE: u32le mode | path\0 | data. Creates the file, or truncates and replaces it. */
static void do_write(uint32_t id, const uint8_t *payload, uint32_t len) {
  if (len < 6) { send_error(id, "write: the request is too short"); return; }
  uint32_t mode = get_u32(payload) & 07777u;
  const uint8_t *path = payload + 4;
  const uint8_t *nul = memchr(path, 0, (size_t)(len - 4));
  if (!nul || nul == path) { send_error(id, "write: a path is needed, ending with a zero byte"); return; }
  const char *name = (const char *)path;
  const uint8_t *data = nul + 1;
  size_t dlen = (size_t)(payload + len - data);
  int fd = open(name, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode ? (mode_t)mode : (mode_t)0644);
  if (fd < 0) {
    char msg[512];
    snprintf(msg, sizeof msg, "write %s: %s", name, strerror(errno));
    send_error(id, msg);
    return;
  }
  int ok = write_full(fd, data, dlen) == 0;
  int saved = errno;
  if (close(fd) != 0 && ok) { ok = 0; saved = errno; }
  if (!ok) {
    char msg[512];
    snprintf(msg, sizeof msg, "write %s: %s", name, strerror(saved));
    send_error(id, msg);
    return;
  }
  send_frame(T_WRITE | T_REPLY, id, NULL, 0);
}

/* READ: path\0 -> the file's bytes, up to what one frame can carry. */
static void do_read(uint32_t id, const uint8_t *payload, uint32_t len) {
  if (len < 2 || payload[len - 1] != 0) { send_error(id, "read: the path must end with a zero byte"); return; }
  const char *name = (const char *)payload;
  int fd = open(name, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    char msg[512];
    snprintf(msg, sizeof msg, "read %s: %s", name, strerror(errno));
    send_error(id, msg);
    return;
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    char msg[512];
    snprintf(msg, sizeof msg, "read %s: %s", name, strerror(errno));
    close(fd);
    send_error(id, msg);
    return;
  }
  if (S_ISDIR(st.st_mode)) {
    char msg[512];
    snprintf(msg, sizeof msg, "read %s: is a folder", name);
    close(fd);
    send_error(id, msg);
    return;
  }
  const size_t cap = MAX_FRAME - 5u - 1024u; /* the reply's own header and a margin */
  size_t size = st.st_size > 0 ? (size_t)st.st_size : 4096;
  if (size > cap) size = cap;
  size_t n = 0;
  uint8_t *buf = malloc(size);
  if (!buf) { close(fd); send_error(id, "read: out of memory"); return; }
  for (;;) {
    if (n == size) {
      if (size >= cap) { free(buf); close(fd); send_error(id, "read: the file is larger than one frame"); return; }
      size_t next = size * 2 > cap ? cap : size * 2;
      uint8_t *grown = realloc(buf, next);
      if (!grown) { free(buf); close(fd); send_error(id, "read: out of memory"); return; }
      buf = grown;
      size = next;
    }
    ssize_t r = read(fd, buf + n, size - n);
    if (r < 0) {
      if (errno == EINTR) continue;
      char msg[512];
      snprintf(msg, sizeof msg, "read %s: %s", name, strerror(errno));
      free(buf); close(fd); send_error(id, msg);
      return;
    }
    if (r == 0) break;
    n += (size_t)r;
  }
  close(fd);
  send_frame(T_READ | T_REPLY, id, buf, (uint32_t)n);
  free(buf);
}

/* ---- background programs ---- */

#define MAX_BG 64
#define BG_LOG_CAP (256u * 1024u) /* per stream; the oldest output is dropped past this */

typedef struct {
  uint32_t id;  /* 0 = a free slot */
  pid_t pid;
  int running;
  int32_t code;
  int in_fd;    /* the host's end of the program's stdin; -1 once closed */
  int out_fd;   /* read ends of the program's stdout and stderr; -1 once they reach end of file */
  int err_fd;
  buf_t out, err;
  char *cmd;
} bg_t;

static bg_t bg[MAX_BG];
static uint32_t bg_next_id = 1;

static void bg_release(bg_t *p) {
  free(p->out.data);
  free(p->err.data);
  free(p->cmd);
  memset(p, 0, sizeof *p);
}

/* Appends to a log, keeping only its last BG_LOG_CAP bytes. */
static void bg_keep_tail(buf_t *b, const uint8_t *src, size_t n) {
  if (n > BG_LOG_CAP) { src += n - BG_LOG_CAP; n = BG_LOG_CAP; }
  if (b->len + n > BG_LOG_CAP) {
    size_t drop = b->len + n - BG_LOG_CAP;
    memmove(b->data, b->data + drop, b->len - drop);
    b->len -= drop;
  }
  uint8_t *grown = realloc(b->data, b->len + n);
  if (!grown) return;
  memcpy(grown + b->len, src, n);
  b->data = grown;
  b->len += n;
}

/* Reads what is waiting on one output pipe. End of file closes it. */
static void bg_read_fd(int *fd, buf_t *b) {
  uint8_t chunk[16384];
  ssize_t n = read(*fd, chunk, sizeof chunk);
  if (n > 0) { bg_keep_tail(b, chunk, (size_t)n); return; }
  if (n < 0 && (errno == EINTR || errno == EAGAIN)) return;
  close(*fd);
  *fd = -1;
}

static void bg_drain(int fd) {
  for (size_t i = 0; i < MAX_BG; i++) {
    if (bg[i].id == 0) continue;
    if (bg[i].out_fd == fd) { bg_read_fd(&bg[i].out_fd, &bg[i].out); return; }
    if (bg[i].err_fd == fd) { bg_read_fd(&bg[i].err_fd, &bg[i].err); return; }
  }
}

/* Records how a background program ended. It can no longer take stdin. */
static void bg_exited(pid_t pid, int status) {
  for (size_t i = 0; i < MAX_BG; i++) {
    if (bg[i].id && bg[i].running && bg[i].pid == pid) {
      bg[i].running = 0;
      bg[i].code = WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 1;
      if (bg[i].in_fd >= 0) { close(bg[i].in_fd); bg[i].in_fd = -1; }
      return;
    }
  }
}

/* Reaps every child that has ended. Background programs get their status recorded; exec's children are reaped by
 * do_exec, which is never running at the same time. */
static void reap_children(void) {
  int status;
  pid_t pid;
  while ((pid = waitpid(-1, &status, WNOHANG)) > 0) bg_exited(pid, status);
}

/* A free slot, or a finished program whose output has been read to the end (its logs are dropped then). */
static bg_t *bg_slot(void) {
  for (size_t i = 0; i < MAX_BG; i++) if (bg[i].id == 0) return &bg[i];
  for (size_t i = 0; i < MAX_BG; i++) {
    if (!bg[i].running && bg[i].in_fd < 0 && bg[i].out_fd < 0 && bg[i].err_fd < 0) {
      bg_release(&bg[i]);
      return &bg[i];
    }
  }
  return NULL;
}

static bg_t *bg_find(uint32_t id) {
  for (size_t i = 0; i < MAX_BG; i++) if (bg[i].id && bg[i].id == id) return &bg[i];
  return NULL;
}

static void close_pair(int p[2]) {
  if (p[0] >= 0) close(p[0]);
  if (p[1] >= 0) close(p[1]);
}

static char *join_argv(char **argv, size_t argc) {
  size_t total = 1;
  for (size_t i = 0; i < argc; i++) total += strlen(argv[i]) + 1;
  char *s = malloc(total);
  if (!s) return NULL;
  s[0] = '\0';
  for (size_t i = 0; i < argc; i++) {
    if (i) strcat(s, " ");
    strcat(s, argv[i]);
  }
  return s;
}

/* SPAWN: cwd\0 argv0\0 argv1\0 ... -> u32le program id. The pipes are close-on-exec, so no program inherits another's. */
static void do_spawn(uint32_t id, const uint8_t *payload, uint32_t len) {
  if (len < 2 || payload[len - 1] != '\0') { send_error(id, "spawn: strings are not NUL terminated"); return; }
  const char *p = (const char *)payload, *end = (const char *)payload + len;
  const char *cwd = p;
  p += strlen(p) + 1;
  size_t argc = 0;
  for (const char *q = p; q < end; q += strlen(q) + 1) argc++;
  if (argc == 0) { send_error(id, "spawn: no command"); return; }
  bg_t *slot = bg_slot();
  if (!slot) { send_error(id, "spawn: too many background programs (limit 64)"); return; }
  char **argv = calloc(argc + 1, sizeof *argv);
  if (!argv) { send_error(id, "spawn: out of memory"); return; }
  size_t i = 0;
  for (const char *q = p; q < end; q += strlen(q) + 1) argv[i++] = (char *)q;

  int pin[2] = {-1, -1}, pout[2] = {-1, -1}, perr[2] = {-1, -1};
  if (pipe2(pin, O_CLOEXEC) < 0 || pipe2(pout, O_CLOEXEC) < 0 || pipe2(perr, O_CLOEXEC) < 0) {
    close_pair(pin); close_pair(pout); close_pair(perr);
    free(argv);
    send_error(id, "spawn: pipe failed");
    return;
  }
  pid_t pid = fork();
  if (pid < 0) {
    close_pair(pin); close_pair(pout); close_pair(perr);
    free(argv);
    send_error(id, "spawn: fork failed");
    return;
  }
  if (pid == 0) {
    dup2(pin[0], 0);
    dup2(pout[1], 1);
    dup2(perr[1], 2);
    signal(SIGPIPE, SIG_DFL);
    if (cwd[0] && chdir(cwd) < 0) { dprintf(2, "canit: cannot chdir to %s: %s\n", cwd, strerror(errno)); _exit(126); }
    execvp(argv[0], argv);
    dprintf(2, "canit: cannot run %s: %s\n", argv[0], strerror(errno));
    _exit(errno == ENOENT ? 127 : 126);
  }
  close(pin[0]);
  close(pout[1]);
  close(perr[1]);
  fcntl(pout[0], F_SETFL, O_NONBLOCK);
  fcntl(perr[0], F_SETFL, O_NONBLOCK);
  char *cmd = join_argv(argv, argc);
  free(argv);
  slot->id = bg_next_id++;
  slot->pid = pid;
  slot->running = 1;
  slot->code = 0;
  slot->in_fd = pin[1];
  slot->out_fd = pout[0];
  slot->err_fd = perr[0];
  slot->cmd = cmd;
  uint8_t b[4];
  put_u32(b, slot->id);
  send_frame(T_SPAWN | T_REPLY, id, b, 4);
}

static void do_logs(uint32_t id, const uint8_t *payload, uint32_t len) {
  if (len != 5) { send_error(id, "logs: the request is a program id and a stream (1 out, 2 err)"); return; }
  bg_t *p = bg_find(get_u32(payload));
  if (!p) { send_error(id, "logs: no such background program"); return; }
  if (payload[4] != 1 && payload[4] != 2) { send_error(id, "logs: the stream is 1 (stdout) or 2 (stderr)"); return; }
  buf_t *b = payload[4] == 1 ? &p->out : &p->err;
  send_frame(T_LOGS | T_REPLY, id, b->data, (uint32_t)b->len);
}

static void do_status(uint32_t id, const uint8_t *payload, uint32_t len) {
  if (len != 4) { send_error(id, "status: the request is a program id"); return; }
  bg_t *p = bg_find(get_u32(payload));
  if (!p) { send_error(id, "status: no such background program"); return; }
  uint8_t b[5];
  b[0] = p->running ? 1 : 0;
  put_u32(b + 1, (uint32_t)p->code);
  send_frame(T_STATUS | T_REPLY, id, b, 5);
}

static void do_kill(uint32_t id, const uint8_t *payload, uint32_t len) {
  if (len != 8) { send_error(id, "kill: the request is a program id and a signal"); return; }
  bg_t *p = bg_find(get_u32(payload));
  if (!p) { send_error(id, "kill: no such background program"); return; }
  if (!p->running) { send_error(id, "kill: the program has already exited"); return; }
  if (kill(p->pid, (int)get_u32(payload + 4)) < 0) {
    char msg[256];
    snprintf(msg, sizeof msg, "kill: %s", strerror(errno));
    send_error(id, msg);
    return;
  }
  send_frame(T_KILL | T_REPLY, id, NULL, 0);
}

static void do_ps(uint32_t id) {
  uint32_t count = 0;
  for (size_t i = 0; i < MAX_BG; i++) if (bg[i].id) count++;
  buf_t out = {0};
  uint8_t head[4];
  put_u32(head, count);
  buf_add(&out, head, 4);
  for (size_t i = 0; i < MAX_BG; i++) {
    if (!bg[i].id) continue;
    size_t cl = strlen(bg[i].cmd);
    uint8_t rec[13];
    put_u32(rec, bg[i].id);
    rec[4] = bg[i].running ? 1 : 0;
    put_u32(rec + 5, (uint32_t)bg[i].code);
    put_u32(rec + 9, (uint32_t)cl);
    buf_add(&out, rec, sizeof rec);
    buf_add(&out, (const uint8_t *)bg[i].cmd, cl);
  }
  send_frame(T_PS | T_REPLY, id, out.data, (uint32_t)out.len);
  free(out.data);
}

static void do_stdin(uint32_t id, const uint8_t *payload, uint32_t len) {
  if (len < 4) { send_error(id, "stdin: the request is a program id and data"); return; }
  bg_t *p = bg_find(get_u32(payload));
  if (!p) { send_error(id, "stdin: no such background program"); return; }
  if (p->in_fd < 0) { send_error(id, "stdin: the program's stdin is closed"); return; }
  if (write_full(p->in_fd, payload + 4, len - 4) < 0) {
    char msg[256];
    snprintf(msg, sizeof msg, "stdin: %s", strerror(errno));
    send_error(id, msg);
    return;
  }
  send_frame(T_STDIN | T_REPLY, id, NULL, 0);
}

static void do_end_stdin(uint32_t id, const uint8_t *payload, uint32_t len) {
  if (len != 4) { send_error(id, "end_stdin: the request is a program id"); return; }
  bg_t *p = bg_find(get_u32(payload));
  if (!p) { send_error(id, "end_stdin: no such background program"); return; }
  if (p->in_fd >= 0) { close(p->in_fd); p->in_fd = -1; }
  send_frame(T_END_STDIN | T_REPLY, id, NULL, 0);
}

static void power_off(void) {
  sync();
  if (is_init) { reboot(RB_POWER_OFF); for (;;) pause(); }
  exit(0);
}

static void serve(void) {
  for (;;) {
    /* Watch the host's channel and every background program's output, so that a program never blocks on a full pipe
     * while the host is idle. The timeout also reaps children that have ended. */
    struct pollfd pfds[1 + 2 * MAX_BG];
    nfds_t n = 0;
    pfds[n++] = (struct pollfd){in_fd, POLLIN, 0};
    for (size_t i = 0; i < MAX_BG; i++) {
      if (bg[i].id == 0) continue;
      if (bg[i].out_fd >= 0) pfds[n++] = (struct pollfd){bg[i].out_fd, POLLIN, 0};
      if (bg[i].err_fd >= 0) pfds[n++] = (struct pollfd){bg[i].err_fd, POLLIN, 0};
    }
    int r = poll(pfds, n, 200);
    reap_children();
    if (r < 0 && errno == EINTR) continue;
    if (r < 0) { usleep(10000); continue; }
    for (nfds_t k = 1; k < n; k++) {
      if (pfds[k].revents & (POLLIN | POLLHUP | POLLERR)) bg_drain(pfds[k].fd);
    }
    if (!(pfds[0].revents & (POLLIN | POLLHUP | POLLERR))) continue;
    uint8_t head[4];
    int got = read_full(in_fd, head, 4);
    if (got == 0) { if (is_init) { usleep(50000); continue; } return; }
    if (got < 0) { if (is_init) { usleep(50000); continue; } return; }
    uint32_t length = get_u32(head);
    if (length < 5 || length > MAX_FRAME) { fprintf(stderr, "canit: bad frame length %u\n", length); return; }
    uint8_t *body = malloc(length);
    if (!body || read_full(in_fd, body, length) != 1) { free(body); return; }
    uint8_t type = body[0];
    uint32_t id = get_u32(body + 1);
    const uint8_t *payload = body + 5;
    uint32_t plen = length - 5;
    switch (type) {
      case T_HELLO: {
        struct utsname u;
        uname(&u);
        char msg[128];
        int n = snprintf(msg, sizeof msg, "canit %s%c%s%c", VERSION, 0, u.machine, 0);
        send_frame(T_HELLO | T_REPLY, id, msg, (uint32_t)n);
        break;
      }
      case T_PING: send_frame(T_PING | T_REPLY, id, payload, plen); break;
      case T_EXEC: do_exec(id, payload, plen); break;
      case T_WRITE: do_write(id, payload, plen); break;
      case T_READ: do_read(id, payload, plen); break;
      case T_SPAWN: do_spawn(id, payload, plen); break;
      case T_LOGS: do_logs(id, payload, plen); break;
      case T_STATUS: do_status(id, payload, plen); break;
      case T_KILL: do_kill(id, payload, plen); break;
      case T_PS: do_ps(id); break;
      case T_STDIN: do_stdin(id, payload, plen); break;
      case T_END_STDIN: do_end_stdin(id, payload, plen); break;
      case T_POWEROFF: send_frame(T_POWEROFF | T_REPLY, id, NULL, 0); free(body); power_off(); return;
      default: {
        char msg[64];
        snprintf(msg, sizeof msg, "unknown request type %u", type);
        send_error(id, msg);
      }
    }
    free(body);
  }
}

/* ---- PID 1 ---- */

static void mount_one(const char *src, const char *dst, const char *type, unsigned long flags) {
  mkdir(dst, 0755);
  if (mount(src, dst, type, flags, NULL) < 0 && errno != EBUSY) fprintf(stderr, "canit: mount %s: %s\n", dst, strerror(errno));
}

static void loopback_up(void) {
  int s = socket(AF_INET, SOCK_DGRAM, 0);
  if (s < 0) return;
  struct ifreq ifr;
  memset(&ifr, 0, sizeof ifr);
  strncpy(ifr.ifr_name, "lo", IFNAMSIZ - 1);
  if (ioctl(s, SIOCGIFFLAGS, &ifr) == 0) { ifr.ifr_flags |= IFF_UP | IFF_RUNNING; ioctl(s, SIOCSIFFLAGS, &ifr); }
  close(s);
}

/* The device under /dev for the virtio-serial port named AGENT_PORT, or -1. */
static int open_agent_port(void) {
  for (int attempt = 0; attempt < 100; attempt++) {
    DIR *d = opendir("/sys/class/virtio-ports");
    struct dirent *e;
    while (d && (e = readdir(d))) {
      if (e->d_name[0] == '.') continue;
      char path[320], name[64] = {0};
      if (strlen(e->d_name) > 64) continue; /* real names are like vport0p1 */
      snprintf(path, sizeof path, "/sys/class/virtio-ports/%s/name", e->d_name);
      int f = open(path, O_RDONLY);
      if (f < 0) continue;
      ssize_t n = read(f, name, sizeof name - 1);
      close(f);
      while (n > 0 && (name[n - 1] == '\n' || name[n - 1] == '\0')) name[--n] = 0;
      if (strcmp(name, AGENT_PORT) == 0) {
        snprintf(path, sizeof path, "/dev/%s", e->d_name);
        closedir(d);
        return open(path, O_RDWR);
      }
    }
    if (d) closedir(d);
    usleep(50000);
  }
  return -1;
}

static void init_system(void) {
  setenv("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin", 1);
  mount_one("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC);
  mount_one("sysfs", "/sys", "sysfs", MS_NOSUID | MS_NODEV | MS_NOEXEC);
  mount_one("devtmpfs", "/dev", "devtmpfs", MS_NOSUID);
  mount_one("devpts", "/dev/pts", "devpts", MS_NOSUID | MS_NOEXEC);
  mount_one("tmpfs", "/tmp", "tmpfs", MS_NOSUID | MS_NODEV);
  mount_one("tmpfs", "/run", "tmpfs", MS_NOSUID | MS_NODEV);
  if (sethostname("can", 3) < 0) fprintf(stderr, "canit: sethostname: %s\n", strerror(errno));
  loopback_up();
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc > 1 && strcmp(argv[1], "--stdio") == 0) {
    serve();
    return 0;
  }
  if (getpid() != 1) {
    fprintf(stderr, "canit: run as PID 1, or with --stdio\n");
    return 2;
  }
  is_init = 1;
  init_system();
  int fd = open_agent_port();
  if (fd < 0) {
    fprintf(stderr, "canit: no virtio-serial port named %s. Next: start the guest with the agent channel.\n", AGENT_PORT);
    sleep(1);
    power_off();
  }
  in_fd = out_fd = fd;
  fprintf(stderr, "canit %s ready\n", VERSION);
  serve();
  power_off();
  return 0;
}
