import { Suspense } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { FranzoniLogo } from '@/components/franzoni-logo';
import { LoginForm } from './login-form';

export default function LoginPage() {
  return (
    <Card className="w-full max-w-md shadow-xl border-franzoni-navy/10">
      <CardHeader className="text-center space-y-4 pt-8">
        <div className="flex justify-center">
          <FranzoniLogo variant="dark" size={88} />
        </div>
        <p className="text-sm text-muted-foreground">Mapa de Carregamento</p>
      </CardHeader>
      <CardContent className="space-y-4 pb-8">
        <Suspense fallback={<div className="h-48 animate-pulse rounded-md bg-muted" />}>
          <LoginForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
