import { z } from 'zod';

export const novaEmpresaSchema = z.object({
  nome: z.string().min(1, 'Nome obrigatório').max(200),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'slug: apenas minúsculas, números e hífen'),
  admin_email: z.string().email('E-mail inválido'),
  admin_nome: z.string().min(1, 'Nome do admin obrigatório').max(200),
});

export type NovaEmpresaInput = z.infer<typeof novaEmpresaSchema>;
