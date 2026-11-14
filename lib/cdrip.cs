// cdrip — tiny Windows audio-CD reader for MiniDisc Manager.
// Compiled on first use with the C# compiler that ships with Windows (.NET Framework).
//
//   cdrip drives                         -> JSON list of CD drives
//   cdrip toc E                          -> JSON table of contents
//   cdrip read E <startLba> <count> out.wav  -> writes a 44.1 kHz 16-bit stereo WAV, prints "P done total"
//   cdrip eject E
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

static class CdRip
{
    const uint GENERIC_READ = 0x80000000;
    const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;
    const uint IOCTL_CDROM_READ_TOC = 0x00024000;
    const uint IOCTL_CDROM_RAW_READ = 0x0002403E;
    const uint IOCTL_STORAGE_EJECT_MEDIA = 0x002D4808;
    const int RAW_SECTOR = 2352;
    const int CHUNK = 20; // sectors per read (~46 KB, under the 64 KB transfer limit)

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle h, uint code, byte[] inBuf, int inSize, byte[] outBuf, int outSize, out int returned, IntPtr overlapped);

    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) throw new ArgumentException("usage: cdrip drives|toc|read|eject ...");
            switch (args[0])
            {
                case "drives": Drives(); break;
                case "toc": Toc(args[1]); break;
                case "read": Read(args[1], int.Parse(args[2]), int.Parse(args[3]), args[4]); break;
                case "eject": Eject(args[1]); break;
                default: throw new ArgumentException("unknown command " + args[0]);
            }
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }

    static string Esc(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }

    static void Drives()
    {
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (var d in DriveInfo.GetDrives())
        {
            if (d.DriveType != DriveType.CDRom) continue;
            string label = "";
            bool ready = false;
            try { ready = d.IsReady; if (ready) label = d.VolumeLabel; } catch { }
            if (!first) sb.Append(",");
            first = false;
            sb.AppendFormat("{{\"letter\":\"{0}\",\"ready\":{1},\"label\":\"{2}\"}}", d.Name.Substring(0, 1), ready ? "true" : "false", Esc(label));
        }
        Console.WriteLine(sb.Append("]").ToString());
    }

    static SafeFileHandle Open(string letter)
    {
        var h = CreateFile(@"\\.\" + letter.Substring(0, 1) + ":", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h.IsInvalid) throw new IOException("Can't open drive " + letter + ": (error " + Marshal.GetLastWin32Error() + ")");
        return h;
    }

    static void Toc(string letter)
    {
        using (var h = Open(letter))
        {
            var buf = new byte[804];
            int got;
            if (!DeviceIoControl(h, IOCTL_CDROM_READ_TOC, null, 0, buf, buf.Length, out got, IntPtr.Zero))
                throw new IOException("No readable audio CD in drive " + letter + ": (error " + Marshal.GetLastWin32Error() + ")");
            int firstTrack = buf[2], lastTrack = buf[3];
            var sb = new StringBuilder();
            sb.AppendFormat("{{\"first\":{0},\"last\":{1},\"tracks\":[", firstTrack, lastTrack);
            int leadout = 0;
            for (int i = 0; i <= lastTrack - firstTrack + 1; i++)
            {
                int o = 4 + i * 8;
                int control = buf[o + 1] & 0x0F;
                int number = buf[o + 2];
                int lba = (buf[o + 5] * 60 + buf[o + 6]) * 75 + buf[o + 7] - 150;
                if (number == 0xAA) { leadout = lba; continue; }
                if (i > 0) sb.Append(",");
                sb.AppendFormat("{{\"n\":{0},\"lba\":{1},\"audio\":{2}}}", number, lba, (control & 0x04) == 0 ? "true" : "false");
            }
            sb.AppendFormat("],\"leadout\":{0}}}", leadout);
            Console.WriteLine(sb.ToString());
        }
    }

    static bool RawRead(SafeFileHandle h, int lba, int count, byte[] outBuf)
    {
        var info = new byte[16]; // RAW_READ_INFO { LARGE_INTEGER DiskOffset; ULONG SectorCount; TRACK_MODE_TYPE TrackMode }
        BitConverter.GetBytes((long)lba * 2048).CopyTo(info, 0);
        BitConverter.GetBytes(count).CopyTo(info, 8);
        BitConverter.GetBytes(2).CopyTo(info, 12); // CDDA
        int got;
        return DeviceIoControl(h, IOCTL_CDROM_RAW_READ, info, 16, outBuf, count * RAW_SECTOR, out got, IntPtr.Zero) && got == count * RAW_SECTOR;
    }

    static void Read(string letter, int start, int count, string outPath)
    {
        using (var h = Open(letter))
        using (var fs = new FileStream(outPath, FileMode.Create, FileAccess.Write))
        {
            long dataLen = (long)count * RAW_SECTOR;
            var w = new BinaryWriter(fs);
            w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write((uint)(36 + dataLen));
            w.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); w.Write(16); w.Write((short)1); w.Write((short)2);
            w.Write(44100); w.Write(44100 * 4); w.Write((short)4); w.Write((short)16);
            w.Write(Encoding.ASCII.GetBytes("data")); w.Write((uint)dataLen);

            var buf = new byte[CHUNK * RAW_SECTOR];
            var one = new byte[RAW_SECTOR];
            int done = 0, bad = 0, lastPct = -1;
            while (done < count)
            {
                int n = Math.Min(CHUNK, count - done);
                bool ok = false;
                for (int attempt = 0; attempt < 3 && !ok; attempt++) ok = RawRead(h, start + done, n, buf);
                if (ok) w.Write(buf, 0, n * RAW_SECTOR);
                else
                {
                    // Fall back to sector-by-sector; write silence for sectors that won't read.
                    for (int s = 0; s < n; s++)
                    {
                        bool sok = false;
                        for (int attempt = 0; attempt < 5 && !sok; attempt++) sok = RawRead(h, start + done + s, 1, one);
                        if (!sok) { Array.Clear(one, 0, one.Length); bad++; }
                        w.Write(one, 0, RAW_SECTOR);
                    }
                }
                done += n;
                int pct = (int)(done * 100L / count);
                if (pct != lastPct) { Console.WriteLine("P " + done + " " + count); lastPct = pct; }
            }
            w.Flush();
            if (bad > 0) Console.WriteLine("BAD " + bad);
        }
    }

    static void Eject(string letter)
    {
        using (var h = Open(letter))
        {
            int got;
            DeviceIoControl(h, IOCTL_STORAGE_EJECT_MEDIA, null, 0, null, 0, out got, IntPtr.Zero);
        }
    }
}
