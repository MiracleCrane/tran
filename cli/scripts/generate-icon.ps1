# Generate Tran's app icon set (clean, high-resolution).
#
# Design: near-black rounded square, white geometric "T", purple dot —
# flat and crisp (no grain), matching the look of the Kimi desktop icon.
# Renders a 1024px master with anti-aliasing, downsamples with
# HighQualityBicubic, and writes:
#   build/icon.png                512x512 (electron-builder / docs)
#   build/icon.ico                multi-size ICO (16..256, PNG-compressed)
#   build/installerIcon.ico       same image (NSIS installer)
#   build/installerHeaderIcon.ico same image (NSIS header)
#   build/uninstallerIcon.ico     same image (NSIS uninstaller)
#   build/desktopShortcutIcon.ico same image (extraResource shortcut icon)
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-icon.ps1

Add-Type -AssemblyName System.Drawing

$buildDir = Join-Path $PSScriptRoot '..\build'
$buildDir = (Resolve-Path $buildDir).Path

$BG_R = 0x10; $BG_G = 0x10; $BG_B = 0x14          # near-black square
$DOT_R = 0x8B; $DOT_G = 0x5C; $DOT_B = 0xF6        # accent purple

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

function Render-Master([int]$S) {
    $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # background rounded square (full bleed, corner radius ~22%)
    $bgPath = Add-RoundedRectPath 0 0 $S $S ($S * 0.22)
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $BG_R, $BG_G, $BG_B))
    $g.FillPath($bgBrush, $bgPath)

    # white "T": top bar + stem, centered at x=0.46 (leaves room for the dot)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $barPath = Add-RoundedRectPath ($S * 0.305) ($S * 0.280) ($S * 0.310) ($S * 0.090) ($S * 0.022)
    $g.FillPath($white, $barPath)
    $stemPath = Add-RoundedRectPath ($S * 0.411) ($S * 0.280) ($S * 0.098) ($S * 0.380) ($S * 0.022)
    $g.FillPath($white, $stemPath)

    # purple dot, top-right
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

function Write-Ico([string]$path, [int[]]$sizes, [System.Drawing.Bitmap]$master) {
    $images = @()
    foreach ($s in $sizes) {
        $resized = Resize-Icon $master $s
        $images += ,@(($s, (Get-PngBytes $resized)))
        $resized.Dispose()
    }
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([uint16]0)              # reserved
    $bw.Write([uint16]1)              # type: icon
    $bw.Write([uint16]$images.Count)  # image count
    $offset = 6 + 16 * $images.Count
    foreach ($img in $images) {
        $s = $img[0]; $data = $img[1]
        $bw.Write([byte]($s % 256))   # width  (0 means 256)
        $bw.Write([byte]($s % 256))   # height
        $bw.Write([byte]0)            # color count
        $bw.Write([byte]0)            # reserved
        $bw.Write([uint16]1)          # planes
        $bw.Write([uint16]32)         # bit depth
        $bw.Write([uint32]$data.Length)
        $bw.Write([uint32]$offset)
        $offset += $data.Length
    }
    foreach ($img in $images) { $bw.Write($img[1]) }
    [System.IO.File]::WriteAllBytes($path, $ms.ToArray())
    $bw.Dispose(); $ms.Dispose()
    Write-Output "wrote $path ($([System.IO.File]::ReadAllBytes($path).Length) bytes)"
}

$master = Render-Master 1024

# 512x512 PNG for electron-builder / general use
$png512 = Resize-Icon $master 512
$png512.Save((Join-Path $buildDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$png512.Dispose()
Write-Output 'wrote icon.png (512x512)'

$icoSizes = @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
foreach ($name in 'icon.ico', 'installerIcon.ico', 'installerHeaderIcon.ico', 'uninstallerIcon.ico', 'desktopShortcutIcon.ico') {
    Write-Ico (Join-Path $buildDir $name) $icoSizes $master
}

$master.Dispose()
