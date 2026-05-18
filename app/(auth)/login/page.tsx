// Placeholder substituído no Prompt 4.
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FranzoniLogo } from '@/components/franzoni-logo';

export default function LoginPlaceholder() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center space-y-3">
        <div className="flex justify-center">
          <FranzoniLogo variant="dark" />
        </div>
        <CardTitle>Login (em construção)</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground text-center">
        O formulário de login será implementado no Prompt 4.
      </CardContent>
    </Card>
  );
}
