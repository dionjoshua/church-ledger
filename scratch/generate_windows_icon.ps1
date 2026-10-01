Add-Type -AssemblyName System.Drawing

$srcPng = "c:\Users\dionj\OneDrive\Desktop\Church offering\mobile\icon-512.png"
$destIco = "c:\Users\dionj\OneDrive\Desktop\Church offering\icon.ico"

# 1. Resize to 256x256 PNG in memory
$bitmap = New-Object System.Drawing.Bitmap(256, 256)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$srcImg = [System.Drawing.Image]::FromFile($srcPng)
$g.DrawImage($srcImg, 0, 0, 256, 256)

$ms = New-Object System.IO.MemoryStream
$bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $ms.ToArray()

$g.Dispose()
$srcImg.Dispose()
$bitmap.Dispose()
$ms.Dispose()

# 2. Write ICO file structure
$fs = New-Object System.IO.FileStream($destIco, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICO Header
$bw.Write([uint16]0) # Reserved
$bw.Write([uint16]1) # Type (1 = Icon)
$bw.Write([uint16]1) # Number of images

# Icon Directory Entry
$bw.Write([byte]0)   # Width (0 means 256)
$bw.Write([byte]0)   # Height (0 means 256)
$bw.Write([byte]0)   # Color count
$bw.Write([byte]0)   # Reserved
$bw.Write([uint16]1) # Color planes
$bw.Write([uint16]32)# Bits per pixel
$bw.Write([uint32]$pngBytes.Length) # Image size
$bw.Write([uint32]22) # Offset of image data (6 header + 16 directory entry)

# Image Data (PNG)
$bw.Write($pngBytes)

$bw.Close()
$fs.Close()

Write-Host "icon.ico created successfully!"
