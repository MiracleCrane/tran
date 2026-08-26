param([Parameter(Mandatory=$true)][string]$Path)
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]

function Await-Op($WinRtTask, $ResultType) {
  $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $task = $m.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage('zh-Hans-CN')
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
$result = Await-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# 输出 JSON：文本 + 字数 + 平均置信度，供调用方判断是否为文字图
$words = @()
foreach ($line in $result.Lines) { foreach ($w in $line.Words) { $words += $w } }
$conf = 0.0
if ($words.Count -gt 0) { $conf = ($words | Measure-Object -Property Confidence -Average).Average }
$out = @{
  text = $result.Text
  chars = ($result.Text -replace '\s', '').Length
  words = $words.Count
  confidence = [math]::Round($conf, 3)
} | ConvertTo-Json -Compress
[Console]::Write($out)
