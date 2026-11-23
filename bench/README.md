# Benchmarks

Every script writes one JSON result file (format at the top of `lib.mjs`). `compare.mjs` merges result files into a markdown table.

## Scenarios (same names for every tool, so rows line up)

| scenario | what is timed | iterations |
|---|---|---|
| `start-true` | create an instance, run `true` in it, tear it down: wall time of the whole cycle | 30, after 3 warmups |
| `exec-echo` | run `echo hi` in an instance that is already running | 100, after 10 warmups |
| `idle-mem` | memory of one started, idle instance, in KB | 5 |
| `parallel-start-10` | start 10 instances at once, each running `true`, wall time until all are done | 10 |

Tools: `docker` (the daemon, `docker run`), `runc` and `crun` (the OCI runtimes called directly, no daemon), `can-lite` (today's JS can), later `can-vm` (QEMU + canos).

A scenario that cannot run is recorded with `ok: false` and the reason; it is never left out and never faked.

## Run

```sh
node bench/can-lite.mjs --out bench/out/can-lite.json            # any OS
node bench/containers.mjs --out bench/out/containers.json        # Linux with docker, runc or crun
node bench/compare.mjs bench/out/*.json                          # markdown table on stdout
```
