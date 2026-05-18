import { redirect } from 'next/navigation';

// O middleware já redireciona usuários autenticados para a área do role;
// quem chegar aqui sem sessão vai para /login.
export default function RootPage() {
  redirect('/vendas');
}
