# Container startup speed: research notes

Status: research only. No code was run and no repo files were changed.
Date of research: 2026-11-23.
Scope: where time goes in `docker run --rm busybox true` (or alpine), which speedups have published evidence, licences of the runtime stack, and what makes it hard to run in a small VM.

Convention: "UNVERIFIED" means I could not confirm the claim from a source I opened. Search-result snippets I did not open are described but not treated as confirmed.

Key caveat: almost all published numbers are from Linux bare metal or Azure VMs, from 2017 to 2024, on different kernels and Docker versions. None measures the stack inside a QEMU guest on Windows or macOS. Numbers below are not transferable to our setup without our own measurement.


## 1. Where the time goes in `docker run --rm busybox true`

Short answer: no published source gives a full per-stage breakdown of `docker run` into the stages asked about. The closest is a 2026 arXiv preprint that measures total warm-start latency and a few components.

What I could confirm:

- Warm-start latency for alpine (Docker 28.x, Azure Standard_D2s_v3, 2 vCPU, 8 GB, overlay2, 50 iterations): about 568 ms on Premium SSD, 1157 ms on Standard HDD, and 1528 ms on Docker Desktop on an M1 Pro Mac (LinuxKit VM under the hypervisor). The paper's exact measurement point is not something I confirmed. Source: arXiv 2602.15214.
- Linux namespace creation: about 8 ms (7.9 ms SSD, 8.5 ms HDD), stated as under 1.5 percent of total startup. Source: arXiv 2602.15214.
- Bridge versus host networking: the paper reports about 0.04 ms overhead on SSD and 0.06 ms on HDD. This conflicts with the anecdotes in section 3, so treat it as one data point. Source: arXiv 2602.15214 (figures as extracted from the HTML page).
- Seccomp: in crun, most user CPU time went to libseccomp compiling the filter. A 2017 run took 159 ms with the seccomp profile and 140 ms without it. After libseccomp fixes (2022 post), the with-seccomp figure was 28.9 ms. Source: Red Hat crun post, 2022 update.
- Namespace and mount costs in crun, before and after kernel/libseccomp fixes: network namespace 47.7 ms to 1.5 ms, IPC namespace 10.9 ms to 0.1 ms, mqueue mount 16.8 ms to 0.7 ms. Same source.
- Storage tier: the HDD-to-SSD warm-start ratio is 2.04x (1157 vs 568 ms). This compares disk types on the same overlay2 driver, not storage drivers. Source: arXiv 2602.15214.

Stage-by-stage status:

- CLI to dockerd API: UNVERIFIED (no number found).
- dockerd to containerd hand-off: UNVERIFIED. A DEV Community write-up describes the chain (CLI, dockerd, containerd, shim, runc) but gives no timings; it is not a source I opened.
- containerd shim creation: UNVERIFIED for time. A forum thread reports shim RSS of about 5 to 6 MB each.
- runc create and start (namespaces, mounts, exec): partly covered. Namespaces are about 8 ms in the arXiv paper. The runtime-level time is 3.9 to 6.9 ms per container in the Red Hat 2020 test (section 2), but that is runc alone, not the full Docker path.
- Network setup (bridge, veth, iptables): no clean number. The arXiv paper says about 0.04 ms for bridge versus host. Forum and academic anecdotes (section 3) claim far more under concurrency. The veth and iptables split is UNVERIFIED.
- Rootfs mount with overlayfs: UNVERIFIED as a separate figure.
- cgroup setup: UNVERIFIED as a separate figure. The arXiv paper reports no separate cgroup timing.
- seccomp and AppArmor: seccomp is covered above (about 19 ms in the 2022 post after fixes, about 140 to 159 ms before). AppArmor: UNVERIFIED.
- Teardown: UNVERIFIED.

Conclusion for question 1: the only way to get our own breakdown is to measure it. The arXiv paper's scripts and data are public (opscart/docker-internals-guide, per the paper), and `strace -f -tt`, `perf`, or containerd and runc debug logs would give per-stage times on our guest.


## 2. Published startup comparisons: runc, crun, youki

Short answer: the only comparisons I could open are maintainer benchmarks. crun is fastest in every one. youki beats runc in its own README benchmark. No independent head-to-head exists that I could find.

| Source (opened) | Date | Hardware and versions | Test | Result |
|---|---|---|---|---|
| Red Hat "Introduction to crun" (redhat.com/sysadmin/introduction-crun) | 2020-08-03 | Not stated (kernel not stated) | 100 sequential `/usr/bin/true` containers, `time -v` | runc: 6.89 s wall, 2.16 s user, 4.60 s sys. crun: 3.86 s wall, 0.53 s user, 1.87 s sys. Max RSS 15.1 MB vs 3.8 MB |
| crun README (github.com/containers/crun) | Not stated | Not stated | 100 sequential `/bin/true` runs | runc 3.34 s, crun 1.69 s (crun about 49 percent less) |
| youki README (github.com/containers/youki) | Not stated (page lists youki 0.3.3, runc 1.1.7, crun 1.15) | Ubuntu 22.04.4, x86_64, kernel 6.5.0, 16 cores, unified cgroups; hyperfine, 10 warmups, 100+ runs; create, start and delete per run | Full lifecycle | youki 111.5 ms (sd 11.6), runc 224.6 ms (sd 12.0), crun 47.3 ms (sd 2.8) |
| Red Hat "Speed up OCI containers" (redhat.com/en/blog/speed-oci-containers) | 2022-11-16 | Two-core SMP machine (per kernel commit quoted); Linux 5.19.15 for modern tests | crun create and destroy, after kernel and libseccomp fixes | About 28.9 ms with seccomp, 5.6 ms with an experimental BPF filter cache (not merged at time of post). Runc not compared |
| Mirantis blog (search result only, not opened) | UNVERIFIED | UNVERIFIED | 50 starts, repeated 10 times | Reported crun ahead of runc for start and `docker exec`. Numbers UNVERIFIED |
| youki README older snapshot (search snippet only) | UNVERIFIED | UNVERIFIED | Older versions | Quoted as youki 198 ms, runc 352 ms, crun 154 ms. Conflicts with the current README above, so treat as old |
| Blog post with 16 ms, 14 ms, 38 ms figures (search snippet only) | UNVERIFIED | UNVERIFIED | No method given | UNVERIFIED, not used |

Notes:

- The youki figures differ between the search snippet and the current README. I use the README as fetched.
- All of the above are maintainer or vendor benchmarks. Hardware is not always stated.
- Per-container gap between runc and crun was about 40 to 70 ms in the 2020 test. Whether this matters in our VM depends on the rest of the path, since dockerd and containerd add more.


## 3. Known speedups and the size of the saving

Short answer: evidence is strong for seccomp filter cost and for lazy pulling under the right conditions. Evidence is thin or missing for the rest. Most numbers come from single benchmarks.

| Technique | Evidence and size of saving | Source | Confidence |
|---|---|---|---|
| Skip dockerd and call containerd (`ctr`, `nerdctl`) or the runtime directly | No measured startup saving found. One blog gives idle memory of about 73 MB for dockerd and 64 MB for containerd. Docker 29.4 ships with containerd 2.2.2, so only the dockerd layer goes | Not opened (search snippet, DataCamp/DEV) | UNVERIFIED for time |
| `--network none` or host networking | arXiv: bridge versus host about 0.04 ms on SSD. Forum: 70 containers with network disabled about 8 s; another user about 2 s with `network_mode: none` on all containers. Academic paper (search snippet): enabling network roughly doubled concurrent startup time, due to lock contention | arXiv 2602.15214 (opened); forum and paper not opened | Mixed. Single-container gap is tiny in one test, large under concurrency in anecdotes |
| Disable seccomp | crun 2017: 159 ms with seccomp vs 140 ms without (about 19 ms, within noise). User CPU 43 ms vs 4 ms. Post-fix with seccomp: 28.9 ms | Red Hat crun post (2022, opened) | Medium. Old kernel, single author. Disabling seccomp is a security cost |
| Reuse a prepared rootfs instead of overlay mounts | No source found | None | UNVERIFIED |
| EROFS snapshotter | containerd docs (2.2) cite about 14 percent faster unpacking for a WordPress image, with erofs-utils 1.8.2. Runtime still uses an overlayfs mount for active snapshots, so the run path is not replaced. No startup-time figure found | containerd EROFS docs (search result, not opened) | Low. Unpacking only |
| Lazy pulling, Nydus (prefetch on) | Microsoft Tech Community (2026-04, opened): llama.cpp TTFT 77.8 s with prefetch_all vs 102.4 s overlayfs uncompressed (about 24 percent) and 139 s gzip (about 44 percent). Without prefetch 223 s. First inference about 28 s slower because of FUSE. Failed to start within 900 s for vLLM. Hardware: A100 80GB on Azure | techcommunity.microsoft.com post (opened) | Medium for that workload. The article's "halve" wording is not what its own numbers show |
| Lazy pulling, stargz / eStargz | Oracle blog: one workload 4 min to 33 s, a single deployment. Harter et al. figure (pull is 76 percent of startup, but 6.4 percent of data is read) is a motivation, not a result | Oracle blog and Kata design notes (search snippets, not opened) | Low (single case) |
| Lazy pulling, Nydus (DeepWiki summary) | 353 MB Node.js image: 15 s vs 126 s on OCI, about 8x. Secondary summary, method unknown | Not opened | UNVERIFIED |
| SOCI (AWS) | Pull time 20 s to 2.5 s (about 7x). Cited via search result; not opened | Not opened | UNVERIFIED |
| CRIU checkpoint and restore | Checkpoint of a 260 MiB Docker container with runc and CRIU: about 65 ms, excluding durability (security paper, search snippet). Restore latency for small containers: UNVERIFIED. Open Liberty InstantOn: "milliseconds" claim, several seconds for typical apps (docs, search snippet) | Not opened | Low for restore |
| Firecracker snapshot restore (context) | Firecracker docs (opened): restore maps the memory file MAP_PRIVATE, so pages load on demand; no latency figures in the doc. Author blog (search snippet): restore as low as 4 ms, about 10 ms for a full Linux system. Practitioner: 28 ms restore vs 1.1 s cold boot. Another project (different VMM): 115 ms restore | Firecracker snapshot-support.md (opened); others not opened | Medium on mechanism, low on numbers. Doc warns that cgroups v1 gives high restore latency; use cgroups v2 |
| gVisor snapshot (context) | Modal reports memory snapshot restore about 2.5x faster than standard container start, no absolute figures | Not opened | Low |
| Pre-warmed pools | No source found | None | UNVERIFIED |

Short ranking by evidence strength for our case:

1. Seccomp filter compile cost: strong mechanism, measured by the crun maintainer. Fix is a library change (perfect hash, cache) rather than disabling.
2. Lazy pulling with prefetch: measured, but only helps when pull dominates startup. For an already-pulled busybox image it does nothing.
3. Snapshot restore (Firecracker-style): best absolute numbers, but it is a VM-level technique, not a change to dockerd.
4. Network: the single-container cost is small in the one measurement we have. Concurrency effects are the open question.
5. Skipping dockerd: plausible, unquantified.


## 4. Licences

Each licence was checked on the repository page (GitHub) unless noted.

| Project | Licence | How checked |
|---|---|---|
| moby (github.com/moby/moby) | Apache License 2.0 | Repository page |
| containerd (github.com/containerd/containerd, LICENSE file) | Apache License 2.0 | LICENSE file, opened |
| runc (github.com/opencontainers/runc) | Apache License 2.0 | Repository page |
| crun (github.com/containers/crun) | GPL-2.0 and LGPL-2.1 (as listed on the page). Check the COPYING file for exact terms | Repository page summary. Not opened at file level |
| youki (github.com/containers/youki) | Apache License 2.0 | Repository page ("Apache-2.0 license"). Search snippet says it moved from MIT to Apache in 2021; not verified |

One sentence on what this means for an installer: Apache 2.0 (moby, containerd, runc, youki) lets us modify and redistribute the binaries, provided we keep the licence and notices and state changes, and it includes a patent grant; crun's GPL-2.0 means that a distributed modified crun must come with its corresponding source under GPL, and it should be shipped as a separate program rather than linked into our own code. This is a summary, not legal advice.


## 5. What makes the stack hard to run in a small VM

Kernel options. The moby `contrib/check-config.sh` script (opened) lists these as required for the Docker stack:

- Namespaces: NAMESPACES, NET_NS, PID_NS, IPC_NS, UTS_NS.
- Cgroups: CGROUPS, CGROUP_CPUACCT, CGROUP_DEVICE, CGROUP_FREEZER, CGROUP_SCHED, CPUSETS, MEMCG. (CGROUP_PIDS is optional.) Cgroups v2 is recommended by the Firecracker doc for latency reasons.
- Storage: at least one of BTRFS_FS, OVERLAY_FS or ZFS. For us: OVERLAY_FS.
- Networking: VETH, BRIDGE, BRIDGE_NETFILTER, plus a long list of IP_NF_* / IP6_NF_* (filter, mangle, nat, raw, masquerade), NETFILTER_XT_MATCH_ADDRTYPE, CONNTRACK, MARK, and NF_NAT.
- Other: KEYS, POSIX_MQUEUE, and CGROUP_BPF (kernel 4.15 or later).
- Optional but relevant for security: USER_NS, SECCOMP, SECCOMP_FILTER, SECURITY_APPARMOR. AppArmor userspace tools are needed only if AppArmor is enabled.

The script's list is for Docker. The exact set needed for our build still needs checking against the guest kernel we ship.

Memory overhead at idle (all anecdotal; no official baseline found):

- One gist (Ubuntu 25.10, 6 idle containers, 64 GB host): dockerd about 107 MB RSS, containerd about 56 MB.
- One 2026 comparison: about 73 MB dockerd, about 64 MB containerd, about 11 MB per shim.
- A 2018 forum post: dockerd up to 57 MB RES. A Debian VM test: about 41 MB for dockerd.
- Shim processes: about 5 to 6 MB RSS each (forum).
- Reports of 300 to 400 MB on a small VPS, and of multi-GB Docker Desktop idle usage on WSL2 (single user), show that the figure depends heavily on version and setup.
- Working estimate for us: tens to low hundreds of MB for dockerd plus containerd. This is UNVERIFIED until we measure it.

Things I could not find a source for:

- Running dockerd or containerd inside a QEMU guest on Windows or macOS (no published setup or numbers).
- Docker Desktop's exact VM footprint on Windows beyond the single forum report.
- Official minimum RAM for dockerd or containerd.

Practical hazards to check first (from the above, not from a source that tested our exact stack):

- Virtualised cgroups v1 and missing CGROUP_BPF or NF_* options cause failures that look like slowdowns or hangs.
- Overlayfs on top of a virtio-9p or virtiofs share is a likely slow path. UNVERIFIED, no source found.


## What I would measure first

1. Our own per-stage timeline of `docker run --rm busybox true` inside the target QEMU guest (strace -f -tt on dockerd, containerd and runc, plus `docker events` timestamps), using the arXiv paper's scripts as a template.
2. `ctr run` versus `docker run` on the same pre-pulled image, to measure the dockerd layer alone.
3. crun versus runc on the same guest kernel with hyperfine (create, start, delete), with seccomp on and off, to get our own figures for section 2 and 3.
4. Idle RSS of dockerd, containerd and one shim after 10 minutes of quiet, plus the guest kernel's `check-config.sh` result.
5. Bridge versus `--network none` versus host for one container and for 20 concurrent containers, since the single-container cost looks small and the concurrency cost is the open question.


## Sources

Opened (fetched and read for this note):

- https://arxiv.org/html/2602.15214v1 (Decomposing Docker Container Startup Performance)
- https://redhat.com/sysadmin/introduction-crun (Red Hat, Introduction to crun, 2020-08-03)
- https://www.redhat.com/en/blog/speed-oci-containers (Red Hat, Speed up OCI containers, 2022-11-16)
- https://github.com/containers/crun (crun README, performance section)
- https://github.com/containers/youki (youki README, benchmark and licence)
- https://github.com/containerd/containerd/blob/main/LICENSE
- https://github.com/moby/moby (licence)
- https://github.com/opencontainers/runc (licence)
- https://github.com/moby/moby/blob/master/contrib/check-config.sh (kernel config checks)
- https://techcommunity.microsoft.com/blog/linuxandopensourceblog/dissecting-llm-container-cold-start-where-the-time-actually-goes/4508831 (Microsoft, 2026-04-15)
- https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md

Seen only in search results, not opened (no claims above rely on them as confirmed): Mirantis crun post; DEV Community Docker vs Podman posts; containerd EROFS docs; Oracle stargz blog; DeepWiki Nydus summary; SOCI paper; Open Liberty InstantOn docs; Firecracker author blog and practitioner benchmark; Modal gVisor post; arXiv 2608.17068 (CRIU checkpoint timing); Docker forum threads on dockerd memory and network startup; the gist on Ubuntu 25.10 memory.

Questions without a usable source: Q1 stage breakdown (no full per-stage measurement; stages for CLI, dockerd, shim, overlay mount, cgroups, AppArmor and teardown are UNVERIFIED); Q3 reusing a prepared rootfs; Q3 pre-warmed pools; Q3 skipping dockerd with a measured saving; Q5 running the stack inside a QEMU guest on Windows or macOS, and an official idle RAM baseline.
