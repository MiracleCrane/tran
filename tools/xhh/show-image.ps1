param([Parameter(Mandatory=$true)][string]$Path)
# 极简原图查看器：无边框置顶窗口
#   滚轮 = 缩放（以鼠标位置为中心）  左键拖动 = 平移
#   左键单击（未拖动）/ Esc = 关闭    双击 = 复位缩放
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$src = New-Object System.Windows.Media.Imaging.BitmapImage
$src.BeginInit()
$src.UriSource = [Uri]$Path
$src.EndInit()

$wa = [System.Windows.SystemParameters]::WorkArea
$maxW = $wa.Width * 0.6
$maxH = $wa.Height * 0.75
$fit = [Math]::Min(1.0, [Math]::Min($maxW / $src.PixelWidth, $maxH / $src.PixelHeight))

$script:scale = New-Object System.Windows.Media.ScaleTransform($fit, $fit)
$script:trans = New-Object System.Windows.Media.TranslateTransform(0, 0)
$group = New-Object System.Windows.Media.TransformGroup
$group.Children.Add($script:scale)
$group.Children.Add($script:trans)

$img = New-Object System.Windows.Controls.Image
$img.Source = $src
$img.Width = $src.PixelWidth
$img.Height = $src.PixelHeight
$img.RenderTransform = $group
$img.RenderTransformOrigin = '0,0'

$canvas = New-Object System.Windows.Controls.Canvas
$canvas.ClipToBounds = $true
$canvas.Children.Add($img)

$win = New-Object System.Windows.Window
$win.WindowStyle = 'None'
$win.AllowsTransparency = $true
$win.Background = 'Transparent'
$win.Topmost = $true
$win.Content = $canvas
$win.Width = $src.PixelWidth * $fit
$win.Height = $src.PixelHeight * $fit
$win.WindowStartupLocation = 'CenterScreen'

# 滚轮缩放（以鼠标位置为锚点）
$win.Add_MouseWheel({
    $factor = if ($_.Delta -gt 0) { 1.15 } else { 1 / 1.15 }
    $newScale = $script:scale.ScaleX * $factor
    if ($newScale -lt 0.05 -or $newScale -gt 20) { return }
    $pos = $_.GetPosition($win)
    # 保持鼠标下的图点不动：T' = M - S'*(M - T)/S
    $script:trans.X = $pos.X - $newScale * ($pos.X - $script:trans.X) / $script:scale.ScaleX
    $script:trans.Y = $pos.Y - $newScale * ($pos.Y - $script:trans.Y) / $script:scale.ScaleY
    $script:scale.ScaleX = $newScale
    $script:scale.ScaleY = $newScale
})

# 左键拖动平移；单击（位移<4px）关闭；双击复位
$script:dragging = $false
$script:dragStart = $null
$script:transStart = $null
$script:moved = 0

$win.Add_MouseLeftButtonDown({
    if ($_.ClickCount -eq 2) {
        $script:scale.ScaleX = $fit; $script:scale.ScaleY = $fit
        $script:trans.X = 0; $script:trans.Y = 0
        return
    }
    $script:dragging = $true
    $script:moved = 0
    $script:dragStart = $_.GetPosition($win)
    $script:transStart = @{ X = $script:trans.X; Y = $script:trans.Y }
    [void]$win.CaptureMouse()
})
$win.Add_MouseMove({
    if (-not $script:dragging) { return }
    $pos = $_.GetPosition($win)
    $dx = $pos.X - $script:dragStart.X
    $dy = $pos.Y - $script:dragStart.Y
    $script:moved = [Math]::Max($script:moved, [Math]::Abs($dx) + [Math]::Abs($dy))
    $script:trans.X = $script:transStart.X + $dx
    $script:trans.Y = $script:transStart.Y + $dy
})
$win.Add_MouseLeftButtonUp({
    $script:dragging = $false
    $win.ReleaseMouseCapture()
    if ($script:moved -lt 4) { $win.Close() }
})
$win.Add_KeyDown({ if ($_.Key -eq 'Escape') { $win.Close() } })
[void]$win.ShowDialog()
