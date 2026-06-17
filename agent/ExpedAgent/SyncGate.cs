namespace ExpedAgent;

/// <summary>
/// Lock compartilhado entre o ciclo automático (Worker) e o gatilho manual "Puxar"
/// (PuxarService). Ambos mexem em state.json/HWM/NfPendentes — serializa pra não corromper.
/// Singleton no DI.
/// </summary>
public sealed class SyncGate
{
    public readonly SemaphoreSlim Lock = new(1, 1);
}
