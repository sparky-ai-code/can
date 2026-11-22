# Windows memory helper

`can-memcap.exe <pid> <limitBytes>` puts one can process in a Job Object with a per-process memory limit and reports its memory.
It is written in C# and uses only kernel32 and psapi P/Invoke, so it needs nothing beyond the .NET Framework 4 that ships with Windows.

## Build

    native\win\build.cmd
    node native/win/build.js

Both write `native/win/build/can-memcap.exe` (git-ignored). The compiler is `%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`.

## Output (one JSON object per line on stdout)

- `{"event":"ready","job":true}`: the limit is enforced. `job:false` means it is not, and the parent samples only.
- `{"private":<bytes>,"peak":<bytes>}`: every 250 ms (PrivateUsage and PeakPagefileUsage).
- `{"event":"limit"}`: once, when the job reports that ProcessMemoryLimit was hit. The helper does not kill the process; the parent decides.
- `{"error":<win32 code>}`: a setup step failed.

Exit codes: 0 the process exited, 1 bad arguments, 2 cannot open the process, 3 cannot set the job limit, 4 stdout closed.

`packaging/stage.mjs` ships the helper as `app/native/win/can-memcap.exe`, and `src/vm/memcap.js` looks for it there and in `native/win/build/`.
