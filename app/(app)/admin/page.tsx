import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function AdminPlaceholder() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Painel Admin</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Dashboard administrativo — a definir.
      </CardContent>
    </Card>
  );
}
