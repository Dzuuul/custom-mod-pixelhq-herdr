# Notifikasi Windows buat Pixel HQ (dipanggil mod company-agents waktu jendela Herdr gak di depan).
# Judul dan isi diterima sebagai parameter, gak pernah dijalankan sebagai perintah.
# Muncul atas nama "Windows PowerShell"; bisa dimatikan di Settings > System > Notifications.
# File ini sengaja ASCII saja: Windows PowerShell 5.1 membaca skrip tanpa BOM sebagai ANSI.
param([string]$Title = 'Pixel HQ', [string]$Body = '')
$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $xml.GetElementsByTagName('text')
[void]$texts.Item(0).AppendChild($xml.CreateTextNode($Title))
[void]$texts.Item(1).AppendChild($xml.CreateTextNode($Body))
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
