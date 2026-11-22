// can-memcap.exe <pid> <limitBytes>
//
// Puts one process (the can's child) in a Job Object with a per-process memory limit, and reports its memory.
// Output: one JSON object per line on stdout.
//   {"event":"ready","job":true|false}   once, after setup. job:false means the limit is NOT enforced.
//   {"error":<win32 code>}               a setup step failed (the step is named in the line before it is printed).
//   {"private":<bytes>,"peak":<bytes>}   every 250 ms while the process runs.
//   {"event":"limit"}                    once, when the job reports the process hit ProcessMemoryLimit.
// Exit codes: 0 the process exited, 1 bad arguments, 2 cannot open the process, 3 cannot set the job limit,
// 4 stdout closed.
//
// Build with the .NET Framework 4 compiler (C# 5, no newer syntax): native\win\build.cmd or native\win\build.js.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class CanMemcap
{
    const uint PROCESS_TERMINATE = 0x0001;
    const uint PROCESS_VM_READ = 0x0010;
    const uint PROCESS_SET_QUOTA = 0x0100;
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint SYNCHRONIZE = 0x00100000;

    const uint WAIT_OBJECT_0 = 0;
    const int SAMPLE_MS = 250;

    const int JobObjectExtendedLimitInformation = 9;
    const int JobObjectAssociateCompletionPortInformation = 7;
    const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
    const uint JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO = 4;
    const uint JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT = 9;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public IntPtr MinimumWorkingSetSize;
        public IntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public IntPtr ProcessMemoryLimit;
        public IntPtr JobMemoryLimit;
        public IntPtr PeakProcessMemoryUsed;
        public IntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT
    {
        public IntPtr CompletionKey;
        public IntPtr CompletionPort;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_MEMORY_COUNTERS_EX
    {
        public uint cb;
        public uint PageFaultCount;
        public IntPtr PeakWorkingSetSize;
        public IntPtr WorkingSetSize;
        public IntPtr QuotaPeakPagedPoolUsage;
        public IntPtr QuotaPagedPoolUsage;
        public IntPtr QuotaPeakNonPagedPoolUsage;
        public IntPtr QuotaNonPagedPoolUsage;
        public IntPtr PagefileUsage;
        public IntPtr PeakPagefileUsage;
        public IntPtr PrivateUsage;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateIoCompletionPort(IntPtr fileHandle, IntPtr existingPort, IntPtr completionKey, uint threads);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out IntPtr key, out IntPtr overlapped, uint millis);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint millis);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool GetProcessMemoryInfo(IntPtr process, out PROCESS_MEMORY_COUNTERS_EX counters, uint size);

    static void Emit(string line)
    {
        Console.Out.Write(line);
        Console.Out.Write("\n");
        Console.Out.Flush();
    }

    static void EmitError(int code)
    {
        Emit("{\"error\":" + code + "}");
    }

    static int Main(string[] args)
    {
        uint pid;
        long limit;
        if (args.Length != 2 || !uint.TryParse(args[0], out pid) || pid == 0 || !long.TryParse(args[1], out limit) || limit <= 0)
        {
            Console.Error.WriteLine("usage: can-memcap <pid> <limitBytes>");
            return 1;
        }

        try
        {
            return Run(pid, limit);
        }
        catch (IOException)
        {
            // stdout is gone (the parent stopped reading); nothing left to report to.
            return 4;
        }
    }

    static int Run(uint pid, long limit)
    {
        IntPtr proc = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, false, pid);
        if (proc == IntPtr.Zero)
        {
            EmitError(Marshal.GetLastWin32Error());
            return 2;
        }

        // The job is kept open for the helper's whole lifetime. Its per-process limit applies to every process
        // in the job, so a grandchild of the can also counts against its own 'limit' (not the sum).
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            EmitError(Marshal.GetLastWin32Error());
            Emit("{\"event\":\"ready\",\"job\":false}");
            return Sample(proc, IntPtr.Zero, false);
        }

        var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        ext.ProcessMemoryLimit = new IntPtr(limit);
        if (!SetJobInfo(job, JobObjectExtendedLimitInformation, ext))
        {
            EmitError(Marshal.GetLastWin32Error());
            return 3;
        }

        IntPtr port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, IntPtr.Zero, 1);
        if (port != IntPtr.Zero)
        {
            var assoc = new JOBOBJECT_ASSOCIATE_COMPLETION_PORT();
            assoc.CompletionKey = job;
            assoc.CompletionPort = port;
            if (!SetJobInfo(job, JobObjectAssociateCompletionPortInformation, assoc))
            {
                EmitError(Marshal.GetLastWin32Error());
                CloseHandle(port);
                port = IntPtr.Zero;
            }
        }
        else
        {
            EmitError(Marshal.GetLastWin32Error());
        }

        bool inJob = AssignProcessToJobObject(job, proc);
        if (!inJob)
        {
            // Keep sampling: the parent falls back to its own limit check, and enforced stays 'sampled'.
            EmitError(Marshal.GetLastWin32Error());
        }
        Emit("{\"event\":\"ready\",\"job\":" + (inJob ? "true" : "false") + "}");

        return Sample(proc, port, inJob);
    }

    static bool SetJobInfo<T>(IntPtr job, int infoClass, T info)
    {
        int size = Marshal.SizeOf(typeof(T));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            return SetInformationJobObject(job, infoClass, buffer, (uint)size);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    // Loop until the process exits: drain job messages, sample memory every 250 ms.
    static int Sample(IntPtr proc, IntPtr port, bool inJob)
    {
        bool limitSent = false;
        uint size = (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS_EX));

        while (true)
        {
            if (port != IntPtr.Zero)
            {
                // The completion port doubles as the 250 ms timer: it wakes early on a job message.
                uint bytes;
                IntPtr key;
                IntPtr overlapped;
                if (GetQueuedCompletionStatus(port, out bytes, out key, out overlapped, SAMPLE_MS))
                {
                    if (bytes == JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT && !limitSent)
                    {
                        limitSent = true;
                        Emit("{\"event\":\"limit\"}");
                    }
                    else if (bytes == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO)
                    {
                        break;
                    }
                    continue;
                }
            }
            else if (WaitForSingleObject(proc, SAMPLE_MS) == WAIT_OBJECT_0)
            {
                break;
            }

            if (WaitForSingleObject(proc, 0) == WAIT_OBJECT_0)
            {
                break;
            }

            PROCESS_MEMORY_COUNTERS_EX counters;
            counters.cb = size;
            if (GetProcessMemoryInfo(proc, out counters, size))
            {
                Emit("{\"private\":" + counters.PrivateUsage.ToInt64() + ",\"peak\":" + counters.PeakPagefileUsage.ToInt64() + "}");
            }
        }

        if (port != IntPtr.Zero) CloseHandle(port);
        CloseHandle(proc);
        return 0;
    }
}
