// LightDesk Windows helper.
//
// Compiled on first run by client.js using csc.exe (part of the .NET Framework,
// present on every Windows install) so the client needs no native npm modules
// and no toolchain.
//
// It is a child process of client.js and speaks a tiny two-way protocol:
//
//   stdin  - one text command per line:
//     cfg <fps> <quality> <scale>   change capture settings (fps 0 = idle)
//     key                           force the next frame even if unchanged
//     aud <0|1>                     stop/start system-audio loopback capture
//     m <x> <y>                     move cursor, x/y normalised 0..1
//     md <b> | mu <b>               button down/up   (0=left 1=right 2=middle)
//     w <delta> <horizontal>        wheel, delta in WHEEL_DELTA units
//     kd <vk> | ku <vk>             key down/up by Windows virtual-key code
//     txt <base64-utf8>             type a unicode string
//     q                             quit
//
//   stdout - length-prefixed binary messages:
//     [int32 payloadLen][byte type][payload]
//       type 1 INFO  : int32 width, int32 height
//       type 2 MEDIA : [byte channel][channel-specific payload]
//       type 3 ERROR : utf8 text
//
//   MEDIA channel 1 (video): uint16 cursorX, uint16 cursorY, uint32 seq, JPEG
//                            bytes. A 9-byte message (header only, no JPEG) is a
//                            cursor move over unchanged pixels.
//   MEDIA channel 2 (audio): uint32 sampleRate, byte channels, byte flags,
//                            then signed 16-bit little-endian PCM.
//
//   The MEDIA payload is byte-for-byte what the browser expects, so client.js
//   forwards it to the relay without touching it.

using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk, wScan;
        public uint dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;

    public const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004,
                      RIGHTDOWN = 0x0008, RIGHTUP = 0x0010,
                      MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040,
                      WHEEL = 0x0800, HWHEEL = 0x1000, ABSOLUTE = 0x8000,
                      VIRTUALDESK = 0x4000;

    public const uint KEY_EXTENDED = 0x0001, KEY_UP = 0x0002, KEY_UNICODE = 0x0004;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint n, INPUT[] inputs, int size);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr hdcDest, int xDest, int yDest, int w, int h,
                                     IntPtr hdcSrc, int xSrc, int ySrc, int rop);

    [DllImport("gdi32.dll")]
    public static extern bool StretchBlt(IntPtr hdcDest, int xDest, int yDest, int wDest, int hDest,
                                         IntPtr hdcSrc, int xSrc, int ySrc, int wSrc, int hSrc, int rop);

    [DllImport("gdi32.dll")]
    public static extern int SetStretchBltMode(IntPtr hdc, int mode);

    [DllImport("winmm.dll")]
    public static extern uint timeBeginPeriod(uint period);

    [DllImport("winmm.dll")]
    public static extern uint timeEndPeriod(uint period);

    public const int SRCCOPY = 0x00CC0020;
    public const int CAPTUREBLT = 0x40000000;
    public const int HALFTONE = 4;
    public const int COLORONCOLOR = 3;

    // -- Desktop switching -----------------------------------------------
    //
    // GDI capture and SendInput are both scoped to whatever desktop the
    // calling *thread* is currently associated with, not the process. The
    // interactive session flips between two desktops that live side by side
    // in the same window station: "Default" for the ordinary logged-on
    // session, and "Winlogon" for anything the OS itself must arbitrate --
    // the lock screen, the "press Ctrl+Alt+Del" / drag-up screen, UAC
    // prompts. A thread that never re-attaches stays stuck on whichever one
    // it opened at startup, which is exactly why locking the screen used to
    // freeze the remote session: input plays into a desktop nobody can see.

    public const uint DESKTOP_ALL_ACCESS = 0x01FF;
    public const int UOI_NAME = 2;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex,
        byte[] pvInfo, int nLength, out int lpnLengthNeeded);

    public static void Mouse(uint flags, int dx, int dy, uint data)
    {
        INPUT[] i = new INPUT[1];
        i[0].type = INPUT_MOUSE;
        i[0].u.mi.dx = dx;
        i[0].u.mi.dy = dy;
        i[0].u.mi.mouseData = data;
        i[0].u.mi.dwFlags = flags;
        SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Key(ushort vk, ushort scan, uint flags)
    {
        INPUT[] i = new INPUT[1];
        i[0].type = INPUT_KEYBOARD;
        i[0].u.ki.wVk = vk;
        i[0].u.ki.wScan = scan;
        i[0].u.ki.dwFlags = flags;
        SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }
}

/* --------------------------------------------------------------------------
 * WASAPI loopback interop.
 *
 * "Loopback" mode hands us whatever the default playback device is rendering,
 * which is exactly the system audio a viewer wants to hear. Only the three
 * interfaces we actually call are declared; every method keeps its HRESULT via
 * PreserveSig so failures are ordinary return codes instead of exceptions
 * thrown from deep inside the marshaller.
 * ------------------------------------------------------------------------ */

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
        [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration,
        long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags,
        out long devicePosition, out long qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}

static class Program
{
    const byte MSG_INFO = 1, MSG_MEDIA = 2, MSG_ERROR = 3;
    const byte CH_VIDEO = 1, CH_AUDIO = 2;

    static Stream stdout;
    static readonly object outLock = new object();

    // Capture settings, written by the input thread and read by the capture loop.
    static volatile int fps = 0;
    static volatile int quality = 55;
    static volatile int scalePct = 100;
    static volatile bool forceKey = true;
    static volatile bool running = true;
    static volatile bool audioOn = false;

    static Rectangle bounds;

    // Virtual-key codes that must carry the EXTENDEDKEY flag to behave correctly.
    static readonly bool[] extended = new bool[256];

    static void Main()
    {
        Native.SetProcessDPIAware();
        Native.timeBeginPeriod(1);   // 1ms sleep granularity, so 30/60fps pacing is honest
        stdout = Console.OpenStandardOutput();

        foreach (int vk in new int[] { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
                                       0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90,
                                       0xA3, 0xA5 })
            extended[vk] = true;

        bounds = Screen.PrimaryScreen.Bounds;

        byte[] info = new byte[8];
        WriteI32(info, 0, bounds.Width);
        WriteI32(info, 4, bounds.Height);
        Emit(MSG_INFO, info, info.Length);

        Thread t = new Thread(InputLoop);
        t.IsBackground = true;
        t.Start();

        Thread a = new Thread(AudioLoop);
        a.IsBackground = true;
        a.Start();

        CaptureLoop();
    }

    /* ------------------------------------------------------------- output -- */

    static void Emit(byte type, byte[] payload, int len)
    {
        lock (outLock)
        {
            byte[] head = new byte[5];
            WriteI32(head, 0, len);
            head[4] = type;
            stdout.Write(head, 0, 5);
            stdout.Write(payload, 0, len);
            stdout.Flush();
        }
    }

    static void EmitError(string msg)
    {
        byte[] b = Encoding.UTF8.GetBytes(msg);
        Emit(MSG_ERROR, b, b.Length);
    }

    /// Writes a video MEDIA message without copying the JPEG into an intermediate
    /// buffer first: 14 bytes of header, then the encoder's buffer straight out.
    static void EmitVideo(byte[] jpeg, int jpegLen, int cx, int cy, uint seq)
    {
        lock (outLock)
        {
            byte[] head = new byte[14];
            WriteI32(head, 0, 9 + jpegLen);
            head[4] = MSG_MEDIA;
            head[5] = CH_VIDEO;
            WriteU16(head, 6, cx);
            WriteU16(head, 8, cy);
            WriteI32(head, 10, (int)seq);
            stdout.Write(head, 0, 14);
            stdout.Write(jpeg, 0, jpegLen);
            stdout.Flush();
        }
    }

    static void WriteI32(byte[] b, int off, int v)
    {
        b[off] = (byte)v; b[off + 1] = (byte)(v >> 8);
        b[off + 2] = (byte)(v >> 16); b[off + 3] = (byte)(v >> 24);
    }

    static void WriteU16(byte[] b, int off, int v)
    {
        b[off] = (byte)v; b[off + 1] = (byte)(v >> 8);
    }

    /* ------------------------------------------------------- desktop sync -- */

    // Each thread carries its own desktop association, so both the capture
    // thread and the input thread call this independently.
    [ThreadStatic] static IntPtr threadDesktop;
    [ThreadStatic] static string threadDesktopName;

    /// Re-attaches the calling thread to whatever desktop currently owns the
    /// input focus, if it isn't already there. A no-op most of the time --
    /// only actually switches when the OS flips between "Default" and
    /// "Winlogon" (lock, sign-in, UAC, screensaver). Silently does nothing if
    /// the process lacks the rights to open the target desktop, which is the
    /// normal case for a plain user-session helper: it just keeps whatever
    /// desktop it started on, exactly as before this existed.
    static bool SyncDesktop()
    {
        IntPtr d = Native.OpenInputDesktop(0, false, Native.DESKTOP_ALL_ACCESS);
        if (d == IntPtr.Zero) return threadDesktop != IntPtr.Zero;

        string name = GetDesktopName(d);
        if (name != null && name == threadDesktopName)
        {
            Native.CloseDesktop(d);
            return true;
        }

        if (Native.SetThreadDesktop(d))
        {
            IntPtr old = threadDesktop;
            threadDesktop = d;
            threadDesktopName = name;
            if (old != IntPtr.Zero) Native.CloseDesktop(old);
            return true;
        }

        Native.CloseDesktop(d);
        return threadDesktop != IntPtr.Zero;
    }

    static string GetDesktopName(IntPtr hDesktop)
    {
        int needed;
        Native.GetUserObjectInformation(hDesktop, Native.UOI_NAME, null, 0, out needed);
        if (needed <= 0) return null;
        byte[] buf = new byte[needed];
        if (!Native.GetUserObjectInformation(hDesktop, Native.UOI_NAME, buf, needed, out needed))
            return null;
        string s = Encoding.Unicode.GetString(buf);
        int z = s.IndexOf('\0');
        return z >= 0 ? s.Substring(0, z) : s;
    }

    /* ------------------------------------------------------------ capture -- */

    static void CaptureLoop()
    {
        ImageCodecInfo jpeg = null;
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
            if (c.MimeType == "image/jpeg") { jpeg = c; break; }

        Bitmap dst = null;
        Graphics dstG = null;
        int dstW = 0, dstH = 0;

        EncoderParameters ep = new EncoderParameters(1);
        int appliedQuality = -1;

        MemoryStream ms = new MemoryStream(1 << 20);
        uint seq = 0;
        ulong lastHash = 0;
        int lastCx = -1, lastCy = -1;
        long nextTick = 0;

        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();

        try
        {
            while (running)
            {
                int f = fps;
                if (f <= 0) { Thread.Sleep(50); nextTick = 0; continue; }
                if (sw.ElapsedMilliseconds < nextTick) { Thread.Sleep(1); continue; }
                nextTick = sw.ElapsedMilliseconds + (1000 / f);

                try
                {
                    // Follow the lock screen / sign-in screen / UAC prompt to
                    // whichever desktop currently has focus before capturing
                    // it. GetDC(NULL) is scoped to the calling thread's
                    // current desktop, so it is re-fetched every frame rather
                    // than cached across a switch.
                    SyncDesktop();
                    IntPtr screenDc = Native.GetDC(IntPtr.Zero);
                    try
                    {

                    if (appliedQuality != quality)
                    {
                        appliedQuality = quality;
                        // Fully qualified: System.Text also defines an Encoder.
                        ep.Param[0] = new EncoderParameter(
                            System.Drawing.Imaging.Encoder.Quality, (long)appliedQuality);
                    }

                    int want = scalePct;
                    int w = Math.Max(16, bounds.Width * want / 100);
                    int h = Math.Max(16, bounds.Height * want / 100);
                    if (dst == null || w != dstW || h != dstH)
                    {
                        if (dstG != null) dstG.Dispose();
                        if (dst != null) dst.Dispose();
                        dstW = w; dstH = h;
                        dst = new Bitmap(w, h, PixelFormat.Format32bppRgb);
                        dstG = Graphics.FromImage(dst);
                        forceKey = true;
                    }

                    // Capture straight into the target bitmap. This replaces the
                    // old GDI+ CopyFromScreen + DrawImage(HighQualityBilinear)
                    // path: BitBlt is the native fast path, and StretchBlt folds
                    // capture + scaling into one GDI call, so we never pay for a
                    // full-resolution copy when the stream is scaled down.
                    IntPtr dstDc = dstG.GetHdc();
                    if (w == bounds.Width && h == bounds.Height)
                    {
                        Native.BitBlt(dstDc, 0, 0, w, h, screenDc,
                                      bounds.X, bounds.Y, Native.SRCCOPY | Native.CAPTUREBLT);
                    }
                    else
                    {
                        Native.SetStretchBltMode(dstDc, Native.COLORONCOLOR);
                        Native.StretchBlt(dstDc, 0, 0, w, h, screenDc,
                                          bounds.X, bounds.Y, bounds.Width, bounds.Height,
                                          Native.SRCCOPY | Native.CAPTUREBLT);
                    }
                    dstG.ReleaseHdc(dstDc);

                    Native.POINT p;
                    Native.GetCursorPos(out p);
                    int cx = Clamp16((p.X - bounds.X) * 65535 / Math.Max(1, bounds.Width));
                    int cy = Clamp16((p.Y - bounds.Y) * 65535 / Math.Max(1, bounds.Height));

                    // Hash the raw captured pixels before touching the JPEG
                    // encoder. A still desktop then costs one capture + one fast
                    // scan instead of a full encode, which leaves far more CPU
                    // for the frames that actually change. BitBlt/StretchBlt do
                    // not draw the cursor, so a pure pointer move hashes the same
                    // and is sent as a 9-byte cursor update below.
                    ulong hash = HashBitmap(dst);
                    bool pixelsSame = !forceKey && hash == lastHash;

                    if (pixelsSame)
                    {
                        if (cx == lastCx && cy == lastCy) continue;
                        lastCx = cx; lastCy = cy;
                        byte[] cur = new byte[9];
                        cur[0] = CH_VIDEO;
                        WriteU16(cur, 1, cx);
                        WriteU16(cur, 3, cy);
                        WriteI32(cur, 5, (int)seq);
                        Emit(MSG_MEDIA, cur, 9);
                        continue;
                    }

                    lastHash = hash;
                    lastCx = cx; lastCy = cy;
                    forceKey = false;
                    seq++;

                    ms.SetLength(0);
                    dst.Save(ms, jpeg, ep);

                    byte[] buf = ms.GetBuffer();
                    int len = (int)ms.Length;
                    EmitVideo(buf, len, cx, cy, seq);
                    }
                    finally
                    {
                        Native.ReleaseDC(IntPtr.Zero, screenDc);
                    }
                }
                catch (Exception e)
                {
                    EmitError("capture: " + e.Message);
                    Thread.Sleep(250);
                }
            }
        }
        finally
        {
            if (dstG != null) dstG.Dispose();
            if (dst != null) dst.Dispose();
        }
    }

    static int Clamp16(int v) { return v < 0 ? 0 : (v > 65535 ? 65535 : v); }

    /// Fast FNV-1a over a bitmap's raw pixels, reading 8 bytes at a time. The
    /// hash is over the stride (padding included); the padding is never written
    /// by BitBlt so it stays constant, which keeps the hash stable across frames.
    unsafe static ulong HashBitmap(Bitmap bmp)
    {
        Rectangle r = new Rectangle(0, 0, bmp.Width, bmp.Height);
        BitmapData bd = bmp.LockBits(r, ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
        try
        {
            int len = bd.Stride * bd.Height;
            byte* p = (byte*)bd.Scan0;
            ulong h = 14695981039346656037UL;
            int n = len / 8;
            ulong* q = (ulong*)p;
            for (int i = 0; i < n; i++) { h ^= q[i]; h *= 1099511628211UL; }
            for (int i = n * 8; i < len; i++) { h ^= p[i]; h *= 1099511628211UL; }
            return h;
        }
        finally
        {
            bmp.UnlockBits(bd);
        }
    }

    /* -------------------------------------------------------------- audio -- */

    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    static readonly Guid SUBTYPE_IEEE_FLOAT = new Guid("00000003-0000-0010-8000-00AA00389B71");

    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    const int CLSCTX_ALL = 23;

    /// Owns the audio session for as long as a viewer wants sound, and gets out
    /// of the way (releasing the endpoint entirely) when nobody does.
    static void AudioLoop()
    {
        while (running)
        {
            if (!audioOn) { Thread.Sleep(100); continue; }
            try
            {
                RunAudioSession();
            }
            catch (Exception e)
            {
                EmitError("audio: " + e.Message);
                audioOn = false;
            }
            Thread.Sleep(250);
        }
    }

    static void RunAudioSession()
    {
        Type t = Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator);
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)Activator.CreateInstance(t);

        IMMDevice dev;
        // eRender / eConsole - the device Windows is actually playing through.
        Check(en.GetDefaultAudioEndpoint(0, 0, out dev), "no playback device");

        object clientObj;
        Check(dev.Activate(ref IID_IAudioClient, CLSCTX_ALL, IntPtr.Zero, out clientObj), "activate");
        IAudioClient client = (IAudioClient)clientObj;

        IntPtr pFmt;
        Check(client.GetMixFormat(out pFmt), "mix format");

        short formatTag = Marshal.ReadInt16(pFmt, 0);
        int srcChannels = Marshal.ReadInt16(pFmt, 2);
        int srcRate = Marshal.ReadInt32(pFmt, 4);
        int blockAlign = Marshal.ReadInt16(pFmt, 12);
        int bits = Marshal.ReadInt16(pFmt, 14);

        bool isFloat = formatTag == 3;
        if (formatTag == -2)   // WAVE_FORMAT_EXTENSIBLE (0xFFFE)
        {
            byte[] sub = new byte[16];
            Marshal.Copy(new IntPtr(pFmt.ToInt64() + 24), sub, 0, 16);
            isFloat = new Guid(sub) == SUBTYPE_IEEE_FLOAT;
        }
        if (!isFloat && bits != 16)
        {
            Marshal.FreeCoTaskMem(pFmt);
            throw new Exception("unsupported mix format (" + bits + "-bit)");
        }

        // 200ms of slack; we drain far more often than that.
        Check(client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                                2000000, 0, pFmt, IntPtr.Zero), "initialize");
        Marshal.FreeCoTaskMem(pFmt);

        object captureObj;
        Check(client.GetService(ref IID_IAudioCaptureClient, out captureObj), "capture service");
        IAudioCaptureClient capture = (IAudioCaptureClient)captureObj;

        // Everything above 32kHz is halved: mono at 24kHz is plenty for desktop
        // audio and costs a quarter of what stereo 48kHz would.
        bool halve = srcRate >= 32000 && (srcRate % 2) == 0;
        int outRate = halve ? srcRate / 2 : srcRate;

        byte[] header = new byte[6];
        WriteI32(header, 0, outRate);
        header[4] = 1;   // mono
        header[5] = 0;   // flags, reserved

        Check(client.Start(), "start");
        try
        {
            byte[] raw = null;
            float[] mono = null;
            float carry = 0;
            bool hasCarry = false;

            while (running && audioOn)
            {
                uint packet;
                if (capture.GetNextPacketSize(out packet) != 0) break;
                if (packet == 0) { Thread.Sleep(8); continue; }

                IntPtr pData;
                uint frames, flags;
                long devPos, qpcPos;
                if (capture.GetBuffer(out pData, out frames, out flags, out devPos, out qpcPos) != 0) break;

                int n = (int)frames;
                bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;

                if (n > 0 && !silent)
                {
                    int need = n * blockAlign;
                    if (raw == null || raw.Length < need) raw = new byte[need * 2];
                    if (mono == null || mono.Length < n) mono = new float[n * 2];
                    Marshal.Copy(pData, raw, 0, need);

                    // Downmix every channel into one, in whatever the device's
                    // native sample format is.
                    for (int i = 0; i < n; i++)
                    {
                        float acc = 0;
                        int baseOff = i * blockAlign;
                        for (int c = 0; c < srcChannels; c++)
                        {
                            int off = baseOff + c * (bits / 8);
                            acc += isFloat
                                ? BitConverter.ToSingle(raw, off)
                                : BitConverter.ToInt16(raw, off) / 32768f;
                        }
                        mono[i] = acc / srcChannels;
                    }

                    EmitAudio(header, mono, n, halve, ref carry, ref hasCarry);
                }

                capture.ReleaseBuffer(frames);
            }
        }
        finally
        {
            client.Stop();
            Marshal.ReleaseComObject(capture);
            Marshal.ReleaseComObject(client);
            Marshal.ReleaseComObject(dev);
            Marshal.ReleaseComObject(en);
        }
    }

    /// Converts one packet of mono floats to 16-bit PCM, optionally decimating
    /// 2:1, and ships it. Pure silence is dropped so an idle machine sends
    /// nothing at all.
    static void EmitAudio(byte[] header, float[] mono, int n, bool halve,
                          ref float carry, ref bool hasCarry)
    {
        int outCount;
        byte[] msg;
        int w = 7;   // channel byte + 6-byte header

        if (halve)
        {
            // A leftover odd sample from the previous packet pairs with the
            // first sample of this one, so the stream never gains or loses time.
            outCount = (n + (hasCarry ? 1 : 0)) / 2;
            msg = new byte[7 + outCount * 2];
            msg[0] = CH_AUDIO;
            Buffer.BlockCopy(header, 0, msg, 1, 6);

            float prev = carry;
            bool have = hasCarry;
            for (int i = 0; i < n; i++)
            {
                if (!have) { prev = mono[i]; have = true; continue; }
                WriteSample(msg, ref w, (prev + mono[i]) * 0.5f);
                have = false;
            }
            carry = have ? prev : 0;
            hasCarry = have;
        }
        else
        {
            outCount = n;
            msg = new byte[7 + outCount * 2];
            msg[0] = CH_AUDIO;
            Buffer.BlockCopy(header, 0, msg, 1, 6);
            for (int i = 0; i < n; i++) WriteSample(msg, ref w, mono[i]);
        }

        if (outCount == 0) return;

        for (int i = 7; i < msg.Length; i++)
            if (msg[i] != 0) { Emit(MSG_MEDIA, msg, msg.Length); return; }
    }

    static void WriteSample(byte[] b, ref int off, float v)
    {
        int s = (int)(v * 32767f);
        if (s > 32767) s = 32767;
        if (s < -32768) s = -32768;
        b[off] = (byte)s;
        b[off + 1] = (byte)(s >> 8);
        off += 2;
    }

    static void Check(int hr, string what)
    {
        if (hr != 0) throw new Exception(what + " failed (0x" + hr.ToString("X8") + ")");
    }

    /* -------------------------------------------------------------- input -- */

    static void InputLoop()
    {
        string line;
        while (running && (line = Console.In.ReadLine()) != null)
        {
            try { Handle(line); }
            catch (Exception e) { EmitError("command: " + e.Message); }
        }
        running = false;   // stdin closed => parent is gone
    }

    static void Handle(string line)
    {
        if (line.Length == 0) return;
        string[] a = line.Split(' ');

        // The input thread has its own desktop association, independent of
        // the capture thread's -- both must follow the lock screen / UAC
        // desktop switch for SendInput to land anywhere visible.
        SyncDesktop();

        switch (a[0])
        {
            case "cfg":
                fps = (int)ParseD(a[1]);
                quality = Clamp((int)ParseD(a[2]), 10, 95);
                scalePct = Clamp((int)Math.Round(ParseD(a[3]) * 100), 25, 100);
                forceKey = true;
                break;

            case "key":
                forceKey = true;
                break;

            case "aud":
                audioOn = a.Length > 1 && a[1] == "1";
                break;

            case "m":
                {
                    int x = (int)Math.Round(Clamp01(ParseD(a[1])) * 65535);
                    int y = (int)Math.Round(Clamp01(ParseD(a[2])) * 65535);
                    Native.Mouse(Native.MOVE | Native.ABSOLUTE, x, y, 0);
                    break;
                }

            case "md": Button((int)ParseD(a[1]), true); break;
            case "mu": Button((int)ParseD(a[1]), false); break;

            case "w":
                {
                    uint flag = (a.Length > 2 && a[2] == "1") ? Native.HWHEEL : Native.WHEEL;
                    Native.Mouse(flag, 0, 0, unchecked((uint)(int)ParseD(a[1])));
                    break;
                }

            case "kd": KeyEvent((int)ParseD(a[1]), true); break;
            case "ku": KeyEvent((int)ParseD(a[1]), false); break;

            case "txt":
                {
                    string s = Encoding.UTF8.GetString(Convert.FromBase64String(a[1]));
                    foreach (char ch in s)
                    {
                        Native.Key(0, (ushort)ch, Native.KEY_UNICODE);
                        Native.Key(0, (ushort)ch, Native.KEY_UNICODE | Native.KEY_UP);
                    }
                    break;
                }

            case "q":
                running = false;
                break;
        }
    }

    static void Button(int b, bool down)
    {
        uint f;
        if (b == 0) f = down ? Native.LEFTDOWN : Native.LEFTUP;
        else if (b == 1) f = down ? Native.RIGHTDOWN : Native.RIGHTUP;
        else if (b == 2) f = down ? Native.MIDDLEDOWN : Native.MIDDLEUP;
        else return;
        Native.Mouse(f, 0, 0, 0);
    }

    static void KeyEvent(int vk, bool down)
    {
        if (vk < 0 || vk > 255) return;
        uint flags = 0;
        if (extended[vk]) flags |= Native.KEY_EXTENDED;
        if (!down) flags |= Native.KEY_UP;
        Native.Key((ushort)vk, 0, flags);
    }

    static double ParseD(string s)
    {
        return double.Parse(s, System.Globalization.CultureInfo.InvariantCulture);
    }

    static double Clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    static int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
}
