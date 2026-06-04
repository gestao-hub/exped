'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { desativarColaboradorAction, reativarColaboradorAction } from './actions';

export function ColaboradorActions({
  userId,
  ativo,
  disabled,
}: {
  userId: string;
  ativo: boolean;
  disabled?: boolean;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();

  function run(
    action: typeof desativarColaboradorAction,
    okMsg: string,
    confirmMsg?: string,
  ) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    start(async () => {
      const r = await action({ id: userId });
      if ('error' in r) toast.error(r.error);
      else {
        toast.success(okMsg);
        router.refresh();
      }
    });
  }

  return ativo ? (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 text-destructive hover:text-destructive"
      disabled={disabled || pending}
      onClick={() =>
        run(
          desativarColaboradorAction,
          'Colaborador desativado',
          'Desativar este colaborador? Ele não conseguirá mais entrar (reversível).',
        )
      }
    >
      {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Desativar'}
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      className="h-8"
      disabled={disabled || pending}
      onClick={() => run(reativarColaboradorAction, 'Colaborador reativado')}
    >
      {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Reativar'}
    </Button>
  );
}
