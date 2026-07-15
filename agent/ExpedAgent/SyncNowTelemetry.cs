namespace ExpedAgent;

public sealed record SyncNowObservation(string CompletedAt, bool Ok, int Synced);

public sealed class SyncNowTelemetry
{
    private SyncNowObservation? _last;

    public SyncNowObservation? Last => Volatile.Read(ref _last);

    public void Record(bool ok, int synced)
    {
        var observation = new SyncNowObservation(
            DateTimeOffset.UtcNow.ToString("O"),
            ok,
            Math.Max(0, synced));
        Volatile.Write(ref _last, observation);
    }
}
