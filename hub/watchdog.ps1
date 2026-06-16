# ExpedWatchdog — auto-suficiencia do LOCAL. Roda a cada 15min (tarefa agendada ExpedWatchdog, -ExecutionPolicy Bypass).
#  1) cache REST do hub fresco (NOTIFY pgrst)
#  2) agente: exatamente UMA instancia viva (sobe se 0; mata duplicatas se >1; destrava se agent.log >15min)
#  3) BACKFILL: repesca pedido que ficou elegivel (sit 2/5/7) DEPOIS do cursor passar
#     (orcamento finalizado fora de ordem de id) — baixa o cursor pro menor id faltante; o dedup do
#     ingest (por documento_erp) recria SO o que falta. Guard anti-loop p/ doc que nunca ingere.
#  Situacoes-gatilho da Franzoni: 2,5,7. Se mudar na nuvem (empresas.agente_situacoes_venda), ajuste $SIT.
$ErrorActionPreference = 'Continue'
$logDir = 'C:\Exped\logs'; if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'watchdog.log'
function Tick($m){ try { Add-Content $log ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss')+'  '+$m) } catch {} }
$psql = 'C:\Exped\bin\pgsql\bin\psql.exe'
$SIT  = '2,5,7'
$WINDOW = 1000

# 1) cache REST fresco
try { & $psql -h 127.0.0.1 -p 54329 -U postgres -d exped -c "NOTIFY pgrst, 'reload schema'" *>$null; Tick 'cache: reload OK' }
catch { Tick ('cache: FALHA '+$_.Exception.Message) }

# 2) agente: garantir UMA instancia viva
$exe = (Get-ChildItem 'C:\Users\*\AppData\Local\ExpedAgent\ExpedAgent.exe' -EA SilentlyContinue | Select-Object -First 1).FullName
$lg  = (Get-ChildItem 'C:\Users\*\AppData\Local\ExpedAgent\agent.log'     -EA SilentlyContinue | Select-Object -First 1).FullName
try {
  $proc = @(Get-Process ExpedAgent -EA SilentlyContinue)
  if ($proc.Count -eq 0) {
    if ($exe) { Start-Process $exe -WorkingDirectory (Split-Path $exe); Tick 'agente parado -> iniciado' } else { Tick 'agente: exe nao achado' }
  }
  elseif ($proc.Count -gt 1) {
    # duplicatas competem pelo state.json -> mata todas e sobe UMA
    Stop-Process -Name ExpedAgent -Force -EA SilentlyContinue; Start-Sleep 2
    if ($exe) { Start-Process $exe -WorkingDirectory (Split-Path $exe) }
    Tick ('agente: '+$proc.Count+' instancias -> reduzido p/ 1')
  }
  else {
    $velho = $false; if ($lg) { $velho = ((Get-Date) - (Get-Item $lg).LastWriteTime).TotalMinutes -gt 15 }
    if ($velho) {
      Stop-Process -Name ExpedAgent -Force -EA SilentlyContinue; Start-Sleep 2
      if ($exe) { Start-Process $exe -WorkingDirectory (Split-Path $exe) }
      Tick 'agente travado (log >15min) -> reiniciado'
    } else { Tick 'agente=on' }
  }
} catch { Tick ('agente: FALHA '+$_.Exception.Message) }

# 3) backfill por situacao
try {
  $stPath = 'C:\ProgramData\ExpedAgent\state.json'
  if (-not (Test-Path $stPath)) {
    Tick 'backfill: sem state.json (1o boot) -- pulando'
  } else {
    $stRaw = Get-Content $stPath -Raw
    $m = ([regex]'"Hwm"\s*:\s*(\d+)').Match($stRaw)
    if (-not $m.Success) {
      Tick 'backfill: Hwm nao encontrado no state.json -- pulando'
    } else {
      $hwm   = [int]$m.Groups[1].Value
      $floor = [Math]::Max(0, $hwm - $WINDOW)
      $ap = (Get-ChildItem 'C:\Users\*\AppData\Local\ExpedAgent\appsettings.json' -EA SilentlyContinue | Select-Object -First 1).FullName
      $cs = (Get-Content $ap -Raw | ConvertFrom-Json).Agent.SqlConnectionString
      $cn = New-Object System.Data.SqlClient.SqlConnection $cs; $cn.Open(); $cmd = $cn.CreateCommand()
      $cmd.CommandText = "SELECT pv.id_pedido_venda AS id, LTRIM(RTRIM(pv.codigo)) AS doc FROM pedido_venda pv WITH (NOLOCK) WHERE pv.excluido=0 AND pv.situacao IN ($SIT) AND pv.id_pedido_venda > $floor AND pv.id_pedido_venda <= $hwm"
      $dt = New-Object System.Data.DataTable; $dt.Load($cmd.ExecuteReader()); $cn.Close()
      $hubRaw = & $psql -h 127.0.0.1 -p 54329 -U postgres -d exped -t -A -c "SELECT documento_erp FROM pedidos WHERE documento_erp LIKE 'L%'"
      $hub = New-Object System.Collections.Generic.HashSet[string]; $hubRaw | ForEach-Object { if ($_) { [void]$hub.Add($_.Trim()) } }
      $gap = @($dt | Where-Object { -not $hub.Contains([string]$_.doc) })
      $markPath = 'C:\Exped\last_backfill.txt'
      if ($gap.Count -gt 0) {
        $minGap = [int](($gap | Measure-Object id -Minimum).Minimum)
        $last = -1; if (Test-Path $markPath) { $last = [int]((Get-Content $markPath -Raw).Trim()) }
        if ($minGap -eq $last) {
          Tick ('backfill: gap PERSISTENTE id '+$minGap+' ('+$gap.Count+' docs) -- nao re-baixei (anti-loop); ver agent.log')
        } else {
          $target = [Math]::Max($floor, $minGap - 1)
          $fresh = Get-Content $stPath -Raw
          [IO.File]::WriteAllText($stPath, ($fresh -replace '("Hwm"\s*:\s*)\d+', ('${1}'+$target)), (New-Object Text.UTF8Encoding($false)))
          Set-Content $markPath $minGap
          Tick ('backfill: '+$gap.Count+' faltando -- cursor '+$hwm+' -> '+$target+' (menor '+$minGap+')')
        }
      } else {
        if (Test-Path $markPath) { Remove-Item $markPath -EA SilentlyContinue }
        Tick 'backfill: nada faltando'
      }
    }
  }
} catch { Tick ('backfill: FALHA '+$_.Exception.Message) }
