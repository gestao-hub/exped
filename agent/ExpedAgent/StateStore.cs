using System.Text.Json;
namespace ExpedAgent;

public sealed class StateStore
{
    private readonly string _path;
    public StateStore()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ExpedAgent");
        Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, "state.json");
    }
    private sealed class State { public int Hwm { get; set; } public int OsHwm { get; set; } }

    private State Load()
    {
        try { return File.Exists(_path) ? (JsonSerializer.Deserialize<State>(File.ReadAllText(_path)) ?? new State()) : new State(); }
        catch { return new State(); }
    }
    private void Save(State s) => File.WriteAllText(_path, JsonSerializer.Serialize(s));

    public int GetHwm() => Load().Hwm;
    public void SetHwm(int hwm) { var s = Load(); s.Hwm = hwm; Save(s); }

    public int GetOsHwm() => Load().OsHwm;
    public void SetOsHwm(int hwm) { var s = Load(); s.OsHwm = hwm; Save(s); }
}
