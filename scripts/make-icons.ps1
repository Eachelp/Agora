# Agora 앱 아이콘 생성기 (Windows 전용, 일회성 디자인 도구)
#
# 그리스 문자 Ἀ 기반으로 각 크기의 PNG를 build/icon-src/에 그립니다.
# npm 이미지 의존성을 추가하지 않으려고 .NET System.Drawing만 사용합니다.
# ICO 조립과 최종 배치는 scripts/make-icons.js가 이어서 수행합니다.
#
# 아이콘을 바꿀 때만 손으로 실행합니다:
#   powershell -File scripts/make-icons.ps1; node scripts/make-icons.js
#
# 작은 크기는 512를 축소하지 않고 각 크기에서 직접 그립니다. 축소하면 획이 뭉개져
# 16px에서 글자가 읽히지 않습니다.

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "build\icon-src"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

# 앱 강조색(chat.css --accent)과 같은 네이비. 글자는 흰색입니다.
$bg = [System.Drawing.ColorTranslator]::FromHtml("#173f78")
$fg = [System.Drawing.Color]::White
# 24px 이상은 기식 부호가 있는 Ἀ(U+1F08)를 씁니다.
# 16~20px에서는 부호가 뭉개져 글자를 오히려 못 읽게 만들므로 부호 없는 Α(U+0391)를
# 조금 더 크게 그립니다. 아주 작은 크기에서 형태를 단순화하는 것은 표준 관행입니다.
$glyphWithPsili = [string][char]0x1F08  # Ἀ — GREEK CAPITAL LETTER ALPHA WITH PSILI
$glyphPlain = [string][char]0x0391      # Α — GREEK CAPITAL LETTER ALPHA
$fontName = "Georgia"  # 16px에서도 획이 무너지지 않으면서 고전 세리프 느낌을 유지합니다

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    # 둥근 사각형 배경. 반지름은 크기에 비례합니다(작은 크기에서 과도하게 둥글지 않게).
    $radius = [Math]::Max(2, [int]($size * 0.22))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $brush = New-Object System.Drawing.SolidBrush($bg)
    $g.FillPath($brush, $path)
    $brush.Dispose()
    $path.Dispose()

    # 글자는 실제 그려지는 경계(측정값) 기준으로 가운데에 맞춥니다.
    # 폰트 메트릭에는 위아래 여백이 들어 있어 그대로 중앙 정렬하면 아래로 처집니다.
    if ($size -lt 24) {
        $glyph = $glyphPlain
        $emSize = $size * 0.70
    } else {
        $glyph = $glyphWithPsili
        $emSize = $size * 0.60
    }
    $font = New-Object System.Drawing.Font($fontName, $emSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $format = [System.Drawing.StringFormat]::GenericTypographic.Clone()
    $format.FormatFlags = $format.FormatFlags -bor [System.Drawing.StringFormatFlags]::NoClip

    $textPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $textPath.AddString($glyph, $font.FontFamily, [int]$font.Style, $emSize, (New-Object System.Drawing.PointF(0, 0)), $format)
    $bounds = $textPath.GetBounds()
    if ($bounds.Width -gt 0 -and $bounds.Height -gt 0) {
        # 실제 잉크 영역이 캔버스 가운데에 오도록 평행 이동합니다.
        $offsetX = ($size - $bounds.Width) / 2 - $bounds.X
        $offsetY = ($size - $bounds.Height) / 2 - $bounds.Y
        $matrix = New-Object System.Drawing.Drawing2D.Matrix
        $matrix.Translate($offsetX, $offsetY)
        $textPath.Transform($matrix)
        $matrix.Dispose()
        $textBrush = New-Object System.Drawing.SolidBrush($fg)
        $g.FillPath($textBrush, $textPath)
        $textBrush.Dispose()
    }
    $textPath.Dispose()
    $format.Dispose()
    $font.Dispose()
    $g.Dispose()
    return $bmp
}

# ICO에 넣을 크기들 + 배포용 512.
$sizes = @(16, 24, 32, 48, 64, 128, 256, 512)
foreach ($size in $sizes) {
    $bmp = New-IconBitmap $size
    $bmp.Save((Join-Path $outDir "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

Write-Output "rendered $($sizes.Count) source PNGs to build/icon-src"
