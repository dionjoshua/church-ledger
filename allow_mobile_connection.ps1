# Script to configure Windows Firewall for Church Ledger mobile connection
Write-Host "Configuring Windows Defender Firewall to allow phone connection..." -ForegroundColor Cyan

$RuleName = "Allow Church Ledger Mobile Server"
$Port = 3000

# Check if running as Admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "ERROR: Please run this script as Administrator!" -ForegroundColor Red
    Write-Host "Right-click the script file and select 'Run with PowerShell' or run PowerShell as Administrator." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit
}

# Remove existing rule if any
Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue

# Add new rule
New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -LocalPort $Port -Protocol TCP -Action Allow -Enabled True

Write-Host "SUCCESS: Windows Firewall has been configured to allow connection on port $Port!" -ForegroundColor Green
Write-Host "Your PC's IP address is: $((Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike "127.*" -and $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -notlike "169.254.*"}).IPAddress | Select-Object -First 1)" -ForegroundColor Yellow
Read-Host "Press Enter to exit"
