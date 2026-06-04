'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { criarColaboradorAction } from './actions';

export function ColaboradorForm() {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState('vendedor');
  const [pending, start] = useTransition();
  const router = useRouter();

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const fullName = String(fd.get('full_name') || '').trim();
    const hiperId = fd.get('hiper_usuario_id');
    const input = {
      full_name: fullName,
      email: String(fd.get('email') || '').trim(),
      password: String(fd.get('password') || ''),
      role,
      hiper_usuario_id: hiperId ? String(hiperId) : undefined,
      hiper_usuario_nome: fullName || undefined,
    };
    start(async () => {
      const r = await criarColaboradorAction(input);
      if ('error' in r) toast.error(r.error);
      else {
        toast.success('Colaborador adicionado');
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="h-4 w-4 mr-1.5" />
        Adicionar colaborador
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adicionar colaborador</DialogTitle>
            <DialogDescription>
              Cria um login para quem usa o Exped. A pessoa entra com o e-mail e a senha definidos aqui.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(e.currentTarget);
            }}
            className="space-y-3"
          >
            <div className="space-y-1">
              <Label htmlFor="full_name">Nome</Label>
              <Input id="full_name" name="full_name" required maxLength={200} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="email">E-mail (login)</Label>
              <Input id="email" name="email" type="email" required placeholder="nome@franzoni.local" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="password">Senha inicial</Label>
              <Input id="password" name="password" required minLength={8} />
            </div>
            <div className="space-y-1">
              <Label>Cargo</Label>
              <Select value={role} onValueChange={(v) => v && setRole(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">admin</SelectItem>
                  <SelectItem value="vendedor">vendedor</SelectItem>
                  <SelectItem value="logistica">logistica</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {role === 'vendedor' && (
              <div className="space-y-1">
                <Label htmlFor="hiper_usuario_id">ID do vendedor no Hiper (opcional)</Label>
                <Input id="hiper_usuario_id" name="hiper_usuario_id" type="number" min={1} placeholder="ex: 12" />
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancelar
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Adicionar'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
