import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function VendasPlaceholder() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Meus Pedidos</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Listagem de pedidos do vendedor — implementada no Prompt 6.
      </CardContent>
    </Card>
  );
}
