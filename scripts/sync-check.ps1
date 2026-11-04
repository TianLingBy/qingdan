[CmdletBinding()]
param(
    [ValidateSet(
        'masterdata',
        'inventory',
        'purchase',
        'processing',
        'sales',
        'settlement',
        'internal-trade',
        'platform',
        'web'
    )]
    [string]$Module
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 模块 -> 路径前缀（与 docs/OWNERSHIP.md 保持一致）。
$ModulePaths = [ordered]@{
    'masterdata'    = @('apps/api/src/modules/masterdata/')
    'inventory'     = @('apps/api/src/modules/inventory/')
    'purchase'      = @('apps/api/src/modules/purchase/')
    'processing'    = @('apps/api/src/modules/processing/')
    'sales'         = @('apps/api/src/modules/sales/')
    'settlement'    = @('apps/api/src/modules/settlement/')
    'internal-trade' = @('apps/api/src/modules/internal-trade/')
    'platform'      = @('apps/api/src/platform/', 'apps/api/migrations/')
    'web'           = @('apps/web/')
}

function Invoke-GhJson {
    param([string[]]$Arguments)

    $previousPreference = $ErrorActionPreference
    $raw = ''
    $exitCode = 1
    try {
        $ErrorActionPreference = 'Continue'
        $raw = (& gh @Arguments 2>$null | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    }
    catch {
        $exitCode = 1
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        return [pscustomobject]@{ Ok = $false; Data = $null }
    }

    try {
        return [pscustomobject]@{
            Ok = $true
            Data = ($raw | ConvertFrom-Json)
        }
    }
    catch {
        return [pscustomobject]@{ Ok = $false; Data = $null }
    }
}

function Show-IssueLine {
    param($Issue)

    $title = ([string]$Issue.title -replace '\s+', ' ').Trim()
    Write-Output ("#{0} {1}" -f $Issue.number, $title)
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$selectedModules = if ($Module) { @($Module) } else { @($ModulePaths.Keys) }
$selectedPrefixes = @(
    foreach ($name in $selectedModules) {
        $ModulePaths[$name]
    }
)

Push-Location $repoRoot
try {
    $branch = (& git branch --show-current 2>$null | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($branch)) {
        $branch = 'detached HEAD'
    }

    $statusLines = @(& git status --porcelain 2>$null)
    $treeState = if ($statusLines.Count -eq 0) {
        '干净'
    }
    else {
        "{0} 处未提交改动" -f $statusLines.Count
    }

    $previousPreference = $ErrorActionPreference
    $fetchExitCode = 1
    try {
        $ErrorActionPreference = 'Continue'
        & git fetch origin main --quiet 2>$null
        $fetchExitCode = $LASTEXITCODE
    }
    catch {
        $fetchExitCode = 1
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    $fetchState = if ($fetchExitCode -eq 0) {
        '刚刚 fetch'
    }
    else {
        'fetch 失败，按本地引用比较'
    }

    $behindText = (& git rev-list --count 'HEAD..origin/main' 2>$null | Out-String).Trim()
    $behind = if ($behindText -match '^\d+$') { [int]$behindText } else { '未知' }

    Write-Output '[1/4] 仓库状态'
    Write-Output ("分支：{0}｜工作树：{1}" -f $branch, $treeState)
    Write-Output ("落后 origin/main：{0} 个提交（{1}）" -f $behind, $fetchState)

    $ghCommand = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue
    $ghAvailable = $null -ne $ghCommand

    Write-Output '[2/4] 谁在动我的路径'
    if (-not $ghAvailable) {
        Write-Output '跳过：未检测到 gh'
    }
    else {
        $prResult = Invoke-GhJson -Arguments @(
            'pr', 'list',
            '--state', 'open',
            '--json', 'number,title,files,author'
        )
        if (-not $prResult.Ok) {
            Write-Output '跳过：gh PR 查询失败'
        }
        else {
            $prs = @($prResult.Data)
            $matchingPrs = @(
                foreach ($pr in @($prs)) {
                    $isMatch = $false
                    foreach ($file in @($pr.files)) {
                        foreach ($prefix in $selectedPrefixes) {
                            if (([string]$file.path).StartsWith(
                                $prefix,
                                [System.StringComparison]::OrdinalIgnoreCase
                            )) {
                                $isMatch = $true
                                break
                            }
                        }
                        if ($isMatch) { break }
                    }
                    if ($isMatch) { $pr }
                }
            )

            if ($matchingPrs.Count -eq 0) {
                Write-Output '无相关开放 PR'
            }
            else {
                foreach ($pr in ($matchingPrs | Select-Object -First 5)) {
                    $title = ([string]$pr.title -replace '\s+', ' ').Trim()
                    $author = if ($null -ne $pr.author) { $pr.author.login } else { 'unknown' }
                    Write-Output ("#{0} {1}（@{2}）" -f $pr.number, $title, $author)
                }
                if ($matchingPrs.Count -gt 5) {
                    Write-Output ("另有 {0} 个相关 PR 未展开" -f ($matchingPrs.Count - 5))
                }
            }
        }
    }

    Write-Output '[3/4] 口径最近变了什么'
    $policyLines = @()
    $logExitCode = 1
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $policyLines = @(
            & git log '--since=7 days ago' --oneline -- packages/contracts docs/decisions.md 2>$null
        )
        $logExitCode = $LASTEXITCODE
    }
    catch {
        $logExitCode = 1
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($logExitCode -ne 0) {
        Write-Output '查询失败'
    }
    elseif ($policyLines.Count -eq 0) {
        Write-Output '无'
    }
    else {
        $policyLines | Select-Object -First 5
        if ($policyLines.Count -gt 5) {
            Write-Output ("另有 {0} 条未展开" -f ($policyLines.Count - 5))
        }
    }

    Write-Output '[4/4] 在等我的与我在等的'
    if (-not $ghAvailable) {
        Write-Output '跳过：未检测到 gh'
    }
    else {
        $assignedResult = Invoke-GhJson -Arguments @(
            'issue', 'list',
            '--state', 'open',
            '--assignee', '@me',
            '--json', 'number,title'
        )
        if (-not $assignedResult.Ok) {
            Write-Output '我名下 issue：跳过（gh 查询失败）'
        }
        else {
            $assignedIssues = @($assignedResult.Data)
            if ($assignedIssues.Count -eq 0) {
                Write-Output '我名下 issue：无'
            }
            else {
                Write-Output '我名下 issue：'
                $assignedIssues |
                    Select-Object -First 3 |
                    ForEach-Object { Show-IssueLine -Issue $_ }
                if ($assignedIssues.Count -gt 3) {
                    Write-Output ("另有 {0} 个未展开" -f ($assignedIssues.Count - 3))
                }
            }
        }

        $allResult = Invoke-GhJson -Arguments @(
            'issue', 'list',
            '--state', 'open',
            '--limit', '200',
            '--json', 'number,title,body'
        )
        if (-not $allResult.Ok) {
            Write-Output '模块相关阻塞：跳过（gh 查询失败）'
        }
        else {
            $allIssues = @($allResult.Data)
            $assignedNumbers = @{}
            if ($assignedResult.Ok) {
                foreach ($issue in @($assignedResult.Data)) {
                    $assignedNumbers[[string]$issue.number] = $true
                }
            }

            $blockedIssues = @(
                foreach ($issue in @($allIssues)) {
                    if ($assignedNumbers.ContainsKey([string]$issue.number)) {
                        continue
                    }

                    $text = '{0}`n{1}' -f $issue.title, $issue.body
                    if ($text -notmatch '(?i)Blocked\s+by') {
                        continue
                    }

                    $mentionsModule = $false
                    foreach ($name in $selectedModules) {
                        if ($text.IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                            $mentionsModule = $true
                            break
                        }
                    }
                    if ($mentionsModule) { $issue }
                }
            )

            if ($blockedIssues.Count -eq 0) {
                Write-Output '模块相关阻塞：无'
            }
            else {
                Write-Output '模块相关阻塞：'
                $blockedIssues |
                    Select-Object -First 3 |
                    ForEach-Object { Show-IssueLine -Issue $_ }
                if ($blockedIssues.Count -gt 3) {
                    Write-Output ("另有 {0} 个未展开" -f ($blockedIssues.Count - 3))
                }
            }
        }
    }

    if (-not $ghAvailable) {
        $remote = (& git remote get-url origin 2>$null | Out-String).Trim()
        $webBase = 'https://github.com/TianLingBy/qingdan'
        if ($remote -match '^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?$') {
            $webBase = "https://github.com/$($Matches[1])/$($Matches[2])"
        }
        elseif ($remote -match '^git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$') {
            $webBase = "https://github.com/$($Matches[1])/$($Matches[2])"
        }

        Write-Output '未检测到 gh，以下用网页看：'
        Write-Output ("Issues: {0}/issues" -f $webBase)
        Write-Output ("Pull requests: {0}/pulls" -f $webBase)
        Write-Output ("仓库 Actions: {0}/actions" -f $webBase)
    }
}
catch {
    Write-Output ("检查中断：{0}" -f $_.Exception.Message)
}
finally {
    Pop-Location
    Write-Output 'SyncCheck-OK'
}
