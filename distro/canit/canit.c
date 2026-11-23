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

enum { T_HELLO = 0x01, T_PING = 0x02, T_EXEC = 0x10, T_POWEROFF = 0x20, T_REPLY = 0x80, T_ERROR = 0xff };

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

static void reap_orphans(void) {
  while (waitpid(-1, NULL, WNOHANG) > 0) {}
}

static void power_off(void) {
  sync();
  if (is_init) { reboot(RB_POWER_OFF); for (;;) pause(); }
  exit(0);
}

static void serve(void) {
  for (;;) {
    struct pollfd pfd = {in_fd, POLLIN, 0};
    int r = poll(&pfd, 1, 1000);
    if (is_init) reap_orphans();
    if (r < 0 && errno == EINTR) continue;
    if (r == 0) continue;
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
