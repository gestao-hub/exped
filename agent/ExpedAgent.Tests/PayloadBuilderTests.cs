using Xunit;

namespace ExpedAgent.Tests;

public sealed class PayloadBuilderTests
{
    [Fact]
    public void Build_UsesHiperCustomerIdAsStableCustomerCode()
    {
        var payload = PayloadBuilder.Build(
            new PedidoHeader
            {
                IdPedidoVenda = 10,
                Codigo = "L001000000010",
                IdEntidadeCliente = 1000373,
                DataHoraGeracao = new DateTime(2026, 7, 15),
            },
            new ClienteRow { Nome = "Cliente Hiper" },
            []);

        Assert.Equal("1000373", payload.ClienteCodigo);
    }
}
