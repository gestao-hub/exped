import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function LogisticaPlaceholder() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fila da Logística</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Fila de pedidos pendentes — implementada no Prompt 7.
      </CardContent>
    </Card>
  );
}
