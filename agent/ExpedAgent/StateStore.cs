using System.Text.Json;
namespace ExpedAgent;

/// <summary>Pedido ingerido sem NF, aguardando faturamento pra re-sincronizar a NF.</summary>
public sealed class NfPendente
{
    public int IdPedidoVenda { get; set; }
    public string DocumentoErp { get; set; } = "";
    public DateTime AddedAtUtc { get; set; }
}

public sealed class StateStore
{
    private readonly string _path;
    public StateStore()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ExpedAgent");
        Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, "state.json");
    }
    private sealed class State
    {
        public int Hwm { get; set; }
        public int OsHwm { get; set; }
        public List<NfPendente> NfPendentes { get; set; } = new();
    }

    private State Load()
    {
        // Tenta o principal e, se corrompido (ex.: queda de energia no meio do Save), cai no .bak —
        // evita resetar Hwm=0 e perder NfPendentes silenciosamente (o que dispararia re-ingestão geral).
        foreach (var p in new[] { _path, _path + ".bak" })
        {
            try { if (File.Exists(p)) { var s = JsonSerializer.Deserialize<State>(File.ReadAllText(p)); if (s != null) return s; } }
            catch { /* corrompido — tenta o backup */ }
        }
        return new State();
    }
    // Escrita ATÔMICA: grava em .tmp, faz backup do bom anterior em .bak, troca por rename (atômico
    // no mesmo volume). Sem isso, um crash no meio do WriteAllText deixava o state.json truncado.
    private void Save(State s)
    {
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(s));
        try { if (File.Exists(_path)) File.Copy(_path, _path + ".bak", true); } catch { /* best-effort */ }
        File.Move(tmp, _path, true);
    }

    public int GetHwm() => Load().Hwm;
    public void SetHwm(int hwm) { var s = Load(); s.Hwm = hwm; Save(s); }

    public int GetOsHwm() => Load().OsHwm;
    public void SetOsHwm(int hwm) { var s = Load(); s.OsHwm = hwm; Save(s); }

    public List<NfPendente> GetNfPendentes() => Load().NfPendentes;

    /// <summary>Adiciona um pedido à lista de "aguardando NF" (no-op se o id já está lá).</summary>
    public void AddNfPendente(int idPedidoVenda, string documentoErp, DateTime nowUtc)
    {
        var s = Load();
        if (s.NfPendentes.Exists(p => p.IdPedidoVenda == idPedidoVenda)) return;
        s.NfPendentes.Add(new NfPendente { IdPedidoVenda = idPedidoVenda, DocumentoErp = documentoErp, AddedAtUtc = nowUtc });
        Save(s);
    }

    public void RemoveNfPendente(int idPedidoVenda)
    {
        var s = Load();
        if (s.NfPendentes.RemoveAll(p => p.IdPedidoVenda == idPedidoVenda) > 0) Save(s);
    }

    /// <summary>Remove pendentes mais antigos que ttlDias (pedido que nunca faturou).</summary>
    public void PruneNfPendentes(DateTime nowUtc, int ttlDias)
    {
        var s = Load();
        if (s.NfPendentes.RemoveAll(p => (nowUtc - p.AddedAtUtc).TotalDays > ttlDias) > 0) Save(s);
    }
}
