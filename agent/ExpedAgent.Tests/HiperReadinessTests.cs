using System.Text.Json;
using ExpedAgent;
using Xunit;

namespace ExpedAgent.Tests;

public sealed class HiperReadinessTests
{
    [Fact]
    public void RequiredSchemaCompatibilityReportsMissingColumns()
    {
        var all = HiperRepository.RequiredColumns.ToArray();
        var missing = HiperRepository.GetMissingRequiredColumns(all.Skip(1));

        Assert.Single(missing);
        Assert.Equal($"{all[0].Table}.{all[0].Column}", missing[0]);
    }

    [Fact]
    public void ProbeQueryIsReadOnlyAndExercisesPedidoVenda()
    {
        var sql = HiperRepository.ReadOnlyProbeSql;

        Assert.Contains("TOP (1)", sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("pedido_venda", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("INSERT", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("UPDATE", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("DELETE", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("MERGE", sql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ReadinessJsonKeepsAgentAndHiperSignalsDistinct()
    {
        var snapshot = AgentReadinessSnapshot.Create(
            processId: 197,
            agentVersion: "test",
            hiper: new HiperReadiness(
                Connected: true,
                QueryOk: false,
                SchemaCompatible: false,
                TargetSchema: AgentInfo.HiperSchemaTarget,
                Database: "Hiper",
                ServerVersion: "16.0",
                SampleOrderId: null,
                MissingColumns: ["pedido_venda.codigo"],
                Error: "schema divergente"),
            syncNow: new SyncNowObservation(
                CompletedAt: "2026-07-14T12:00:04.0000000+00:00",
                Ok: true,
                Synced: 3));

        using var json = JsonDocument.Parse(JsonSerializer.Serialize(snapshot));
        Assert.Equal(197, json.RootElement.GetProperty("pid").GetInt32());
        Assert.True(json.RootElement.GetProperty("lastSyncNowOk").GetBoolean());
        Assert.Equal(3, json.RootElement.GetProperty("lastSyncNowSynced").GetInt32());
        var hiper = json.RootElement.GetProperty("hiper");
        Assert.True(hiper.GetProperty("connected").GetBoolean());
        Assert.False(hiper.GetProperty("queryOk").GetBoolean());
        Assert.False(hiper.GetProperty("schemaCompatible").GetBoolean());
    }
}
