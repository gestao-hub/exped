import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function HistoricoPlaceholder() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Histórico</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Histórico de pedidos finalizados — implementado no Prompt 7.
      </CardContent>
    </Card>
  );
}
