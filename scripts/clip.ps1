$img = Get-Clipboard -Format Image
if ($img) { $img.Save("C:\users\swami.kevala\maths\swayambhu\repo\screenshots\clip.png"); Write-Host "saved" } else { Write-Host "no image in clipboard" }
