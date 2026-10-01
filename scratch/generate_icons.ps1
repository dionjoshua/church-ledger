Add-Type -AssemblyName System.Drawing

$sourcePath = "c:\Users\dionj\OneDrive\Desktop\Church offering\mobile\icon-512.png"
$resDir     = "c:\Users\dionj\OneDrive\Desktop\Church offering\android-app\app\src\main\res"

# Remove adaptive icon XML overrides so launcher uses our PNG directly
$anydpiDir = Join-Path $resDir "mipmap-anydpi-v26"
if (Test-Path $anydpiDir) {
    Remove-Item $anydpiDir -Recurse -Force
    Write-Host "Removed mipmap-anydpi-v26 (adaptive icon overrides)"
}

$densities = @{
    "mipmap-mdpi"    = 48
    "mipmap-hdpi"    = 72
    "mipmap-xhdpi"   = 96
    "mipmap-xxhdpi"  = 144
    "mipmap-xxxhdpi" = 192
}

function Resize-Image {
    param ([string]$SrcPath, [string]$DestPath, [int]$Width, [int]$Height)
    $srcImage  = [System.Drawing.Image]::FromFile($SrcPath)
    $destImage = New-Object System.Drawing.Bitmap($Width, $Height)
    $graphics  = [System.Drawing.Graphics]::FromImage($destImage)
    $graphics.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.DrawImage($srcImage, 0, 0, $Width, $Height)
    $destImage.Save($DestPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $destImage.Dispose(); $srcImage.Dispose()
}

function Resize-Circular-Image {
    param ([string]$SrcPath, [string]$DestPath, [int]$Width, [int]$Height)
    $srcImage  = [System.Drawing.Image]::FromFile($SrcPath)
    $destImage = New-Object System.Drawing.Bitmap($Width, $Height)
    $graphics  = [System.Drawing.Graphics]::FromImage($destImage)
    $graphics.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse(0, 0, $Width, $Height)
    $graphics.SetClip($path)
    $graphics.DrawImage($srcImage, 0, 0, $Width, $Height)
    $destImage.Save($DestPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $destImage.Dispose(); $srcImage.Dispose()
}

foreach ($dir in $densities.Keys) {
    $size   = $densities[$dir]
    $folder = Join-Path $resDir $dir

    # Remove old webp icons if present
    Remove-Item (Join-Path $folder "ic_launcher.webp")       -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $folder "ic_launcher_round.webp")  -ErrorAction SilentlyContinue

    $destSquare = Join-Path $folder "ic_launcher.png"
    $destRound  = Join-Path $folder "ic_launcher_round.png"

    Resize-Image         -SrcPath $sourcePath -DestPath $destSquare -Width $size -Height $size
    Resize-Circular-Image -SrcPath $sourcePath -DestPath $destRound  -Width $size -Height $size

    Write-Host "Generated square and round icons in $dir ($size x $size px)"
}

Write-Host ""
Write-Host "All Android launcher icons generated successfully!"
