param([Parameter(Mandatory=$true)][string]$Path)
# 极简原图查看器：无边框置顶窗口，Esc/左键关闭
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$src = New-Object System.Windows.Media.Imaging.BitmapImage
$src.BeginInit()
$src.UriSource = [Uri]$Path
$src.EndInit()

$wa = [System.Windows.SystemParameters]::WorkArea
$maxW = $wa.Width * 0.6
$maxH = $wa.Height * 0.75
$scale = [Math]::Min(1.0, [Math]::Min($maxW / $src.PixelWidth, $maxH / $src.PixelHeight))

$img = New-Object System.Windows.Controls.Image
$img.Source = $src
$img.Width = $src.PixelWidth * $scale
$img.Height = $src.PixelHeight * $scale

$win = New-Object System.Windows.Window
$win.WindowStyle = 'None'
$win.AllowsTransparency = $true
$win.Background = 'Transparent'
$win.Topmost = $true
$win.Content = $img
$win.Width = $img.Width
$win.Height = $img.Height
$win.WindowStartupLocation = 'CenterScreen'
$win.Add_KeyDown({ if ($_.Key -eq 'Escape') { $win.Close() } })
$win.Add_MouseLeftButtonDown({ $win.Close() })
[void]$win.ShowDialog()
