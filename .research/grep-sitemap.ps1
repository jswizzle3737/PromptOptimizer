$xml = Get-Content 'C:\Users\jswiz\Desktop\prompt-optimizer-extension\.research\gcai-sitemap.xml' -Raw
$matches = [regex]::Matches($xml, '<loc>([^<]*)</loc>')
$matches | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -match 'prompt|improv|playbook|enhance' } | Sort-Object -Unique
