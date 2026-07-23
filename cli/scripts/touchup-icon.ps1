# 图标修斑：调暗 T 竖笔下方的亮颗粒（任务栏小尺寸下像一坨白渍），
# 并做尺寸自适应 ICO：
#   - 64/96/128/256：修斑后的母版高质量缩小（保留月壤纹理）
#   - 16/20/24/32/40/48：无纹理扁平渲染（黑底 + 白 T + 紫点），小尺寸零污渍
# 输出：build/icon.png（修斑母版）、5 个 ICO、renderer/assets/app-icon.png。
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/touchup-icon.ps1

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.InteropServices

$cliDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildDir = Join-Path $cliDir 'build'

$BG_R = 0x10; $BG_G = 0x10; $BG_B = 0x14
$DOT_R = 0x8B; $DOT_G = 0x5C; $DOT_B = 0xF6

function Smooth01([double]$t) {
    $t = [Math]::Max(0.0, [Math]::Min(1.0, $t))
    return $t * $t * (3 - 2 * $t)
}

# ---- 1. 修斑：读入 icon.png，调暗 T 下方亮颗粒（LockBits 快速通道） ----
# 从 MemoryStream 构造，避免 GDI+ 文件锁导致无法覆盖保存同名文件。
$fileBytes = [System.IO.File]::ReadAllBytes((Join-Path $buildDir 'icon.png'))
$memStream = [System.IO.MemoryStream]::new($fileBytes)
$src = [System.Drawing.Bitmap]::FromStream($memStream)
$S = $src.Width
$rect = New-Object System.Drawing.Rectangle(0, 0, $S, $S)
$data = $src.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = [byte[]]::new($data.Stride * $S)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)

for ($y = 0; $y -lt $S; $y++) {
    $fy = $y / [double]$S
    for ($x = 0; $x -lt $S; $x++) {
        $fx = $x / [double]$S
        # 核心区：T 竖笔正下方（x 0.30-0.72, y 0.63-0.85），羽化 0.05
        $mx = (Smooth01(($fx - 0.25) / 0.05)) * (1 - (Smooth01(($fx - 0.72) / 0.05)))
        $my = (Smooth01(($fy - 0.58) / 0.05)) * (1 - (Smooth01(($fy - 0.85) / 0.05)))
        $core = $mx * $my * 0.80
        # 全局：y 0.60-0.82 以上区域轻度压暗（0.35 封顶），让纹理整体上移出 T 的周围
        $global = (1 - (Smooth01(($fy - 0.60) / 0.22))) * 0.35
        if ($fy -gt 0.82) { $global = 0 }
        $dim = [Math]::Max($core, $global)
        if ($dim -le 0) { continue }
        $idx = $y * $data.Stride + $x * 4
        $a = $bytes[$idx + 3]
        if ($a -eq 0) { continue }
        # 只压有色亮斑（颗粒），不碰纯白 T：亮度阈值
        $lum = ($bytes[$idx] + $bytes[$idx + 1] + $bytes[$idx + 2]) / 3.0
        if ($lum -gt 200) { continue }
        $keep = 1.0 - $dim
        $bytes[$idx]     = [byte]($bytes[$idx] * $keep)
        $bytes[$idx + 1] = [byte]($bytes[$idx + 1] * $keep)
        $bytes[$idx + 2] = [byte]($bytes[$idx + 2] * $keep)
    }
}
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
$src.UnlockBits($data)
$src.Save((Join-Path $buildDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$src.Save((Join-Path $cliDir 'src\renderer\assets\app-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$src.Dispose()
$memStream.Dispose()
Write-Output 'icon.png touched up (+ renderer assets copy)'

# ---- 2. 尺寸自适应 ICO ----
function Add-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return ,$path
}

function Render-Flat([int]$S) {
    # 小尺寸无纹理版：黑底圆角方块 + 白 T（与母版同几何）+ 紫点
    $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $bgPath = Add-RoundedRectPath 0 0 $S $S ($S * 0.22)
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $BG_R, $BG_G, $BG_B))
    $g.FillPath($bgBrush, $bgPath)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $barPath = Add-RoundedRectPath ($S * 0.305) ($S * 0.280) ($S * 0.310) ($S * 0.090) ($S * 0.022)
    $g.FillPath($white, $barPath)
    $stemPath = Add-RoundedRectPath ($S * 0.411) ($S * 0.280) ($S * 0.098) ($S * 0.380) ($S * 0.022)
    $g.FillPath($white, $stemPath)
    $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $DOT_R, $DOT_G, $DOT_B))
    $dotR = $S * 0.055
    $g.FillEllipse($dotBrush, ($S * 0.723 - $dotR), ($S * 0.293 - $dotR), ($dotR * 2), ($dotR * 2))
    $g.Dispose()
    return ,$bmp
}

function Resize-Icon([System.Drawing.Bitmap]$master, [int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($master, 0, 0, $size, $size)
    $g.Dispose()
    return ,$bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    return ,$bytes
}

function Write-Ico([string]$path, [System.Drawing.Bitmap]$master) {
    $flatSizes = @(16, 20, 24, 32, 40, 48)
    $texSizes = @(64, 96, 128, 256)
    $images = @()
    foreach ($s in $flatSizes) {
        $flat = Render-Flat $s
        $images += ,@(($s, (Get-PngBytes $flat)))
        $flat.Dispose()
    }
    foreach ($s in $texSizes) {
        $resized = Resize-Icon $master $s
        $images += ,@(($s, (Get-PngBytes $resized)))
        $resized.Dispose()
    }
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($img in $images) {
        $s = $img[0]; $data = $img[1]
        $bw.Write([byte]($s % 256))
        $bw.Write([byte]($s % 256))
        $bw.Write([byte]0)
        $bw.Write([byte]0)
        $bw.Write([uint16]1)
        $bw.Write([uint16]32)
        $bw.Write([uint32]$data.Length)
        $bw.Write([uint32]$offset)
        $offset += $data.Length
    }
    foreach ($img in $images) { $bw.Write($img[1]) }
    [System.IO.File]::WriteAllBytes($path, $ms.ToArray())
    $bw.Dispose(); $ms.Dispose()
    Write-Output "wrote $path"
}

$master = [System.Drawing.Bitmap]::FromFile((Join-Path $buildDir 'icon.png'))
foreach ($name in 'icon.ico', 'installerIcon.ico', 'installerHeaderIcon.ico', 'uninstallerIcon.ico', 'desktopShortcutIcon.ico') {
    Write-Ico (Join-Path $buildDir $name) $master
}
$master.Dispose()
