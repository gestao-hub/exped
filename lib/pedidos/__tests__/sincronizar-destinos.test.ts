import { describe, it, expect } from 'vitest';
import { sincronizarDestinos, normalizarParaForm } from '@/lib/pedidos/sincronizar-destinos';
import type { ItemInput, PedidoFormInput } from '@/lib/validators/pedido';

type PontoInput = PedidoFormInput['pontos_retirada'][number];

function item(over: Partial<ItemInput> = {}): ItemInput {
  return {
    codigo: 'C',
    descricao: 'desc',
    quantidade: 1,
    unidade: 'UN',
    preco_unitario: 10,
    desconto: 0,
    total: 10,
    modalidade: 'loja',
    ...over,
  };
}

describe('sincronizarDestinos', () => {
  it('só itens imediato → 1 ponto imediato com os itens (container, sem destino)', () => {
    const pontos = sincronizarDestinos({
      itens: [
        item({ codigo: 'I1', modalidade: 'imediato' }),
        item({ codigo: 'I2', modalidade: 'imediato' }),
      ],
    });
    // NÃO é mais um ponto loja vazio (placeholder); é um ponto imediato real que
    // carrega os itens — senão os itens viram órfãos e somem ao salvar (data loss).
    expect(pontos).toHaveLength(1);
    expect(pontos[0].tipo).toBe('imediato');
    expect(pontos[0].empresa_nome).toBe('');
    expect(pontos[0].itens.map((i) => i.codigo)).toEqual(['I1', 'I2']);
    expect(pontos[0].itens.every((i) => i.modalidade === 'imediato')).toBe(true);
  });

  it('itens loja → 1 ponto loja com todos os itens loja', () => {
    const pontos = sincronizarDestinos({
      itens: [item({ codigo: 'A' }), item({ codigo: 'B' })],
      loja: { empresa_nome: 'Loja Centro', endereco: 'Rua 1' },
    });
    expect(pontos).toHaveLength(1);
    expect(pontos[0].tipo).toBe('loja');
    expect(pontos[0].empresa_nome).toBe('Loja Centro');
    expect(pontos[0].endereco).toBe('Rua 1');
    expect(pontos[0].itens.map((i) => i.codigo)).toEqual(['A', 'B']);
  });

  it('itens entrega → 1 ponto entrega com endereço do destino', () => {
    const pontos = sincronizarDestinos({
      itens: [item({ codigo: 'E', modalidade: 'entrega' })],
      entrega: { empresa_nome: 'Cliente', endereco: 'Av. Brasil, 100' },
    });
    expect(pontos).toHaveLength(1);
    expect(pontos[0].tipo).toBe('entrega');
    expect(pontos[0].endereco).toBe('Av. Brasil, 100');
    expect(pontos[0].itens).toHaveLength(1);
  });

  it('mix (loja + entrega + imediato) → 3 pontos; item imediato preservado num ponto imediato', () => {
    const pontos = sincronizarDestinos({
      itens: [
        item({ codigo: 'L1', modalidade: 'loja' }),
        item({ codigo: 'E1', modalidade: 'entrega' }),
        item({ codigo: 'I1', modalidade: 'imediato' }),
        item({ codigo: 'L2', modalidade: 'loja' }),
      ],
      loja: { empresa_nome: 'Loja' },
      entrega: { empresa_nome: 'Cliente', endereco: 'End' },
    });
    expect(pontos.map((p) => p.tipo)).toEqual(['loja', 'entrega', 'imediato']);
    const loja = pontos.find((p) => p.tipo === 'loja')!;
    const entrega = pontos.find((p) => p.tipo === 'entrega')!;
    const imediato = pontos.find((p) => p.tipo === 'imediato')!;
    expect(loja.itens.map((i) => i.codigo)).toEqual(['L1', 'L2']);
    expect(entrega.itens.map((i) => i.codigo)).toEqual(['E1']);
    // o item imediato NÃO é descartado: vive no ponto imediato (container).
    expect(imediato.itens.map((i) => i.codigo)).toEqual(['I1']);
    const todosCodigos = pontos.flatMap((p) => p.itens.map((i) => i.codigo));
    expect(todosCodigos).toContain('I1');
  });

  it('preserva a PK (id) dos pontos quando informada → permite UPDATE in-place', () => {
    const pontos = sincronizarDestinos({
      itens: [item({ modalidade: 'loja' }), item({ modalidade: 'entrega' })],
      loja: { id: 'ponto-loja-1', empresa_nome: 'L' },
      entrega: { id: 'ponto-entrega-1', endereco: 'E' },
    });
    expect(pontos.find((p) => p.tipo === 'loja')!.id).toBe('ponto-loja-1');
    expect(pontos.find((p) => p.tipo === 'entrega')!.id).toBe('ponto-entrega-1');
  });

  it('preserva a modalidade original de cada item (fonte da verdade)', () => {
    const pontos = sincronizarDestinos({
      itens: [item({ modalidade: 'loja' }), item({ modalidade: 'entrega' })],
    });
    expect(pontos.find((p) => p.tipo === 'loja')!.itens[0].modalidade).toBe('loja');
    expect(pontos.find((p) => p.tipo === 'entrega')!.itens[0].modalidade).toBe('entrega');
  });
});

describe('sincronizarDestinos — multi-endereço de entrega (Task 10)', () => {
  it('2 itens entrega com endereço DIFERENTE → 2 pontos entrega, cada um com seus itens + endereço', () => {
    const pontos = sincronizarDestinos({
      itens: [
        item({ codigo: 'E1', modalidade: 'entrega', endereco_entrega_id: 'end-A' }),
        item({ codigo: 'E2', modalidade: 'entrega', endereco_entrega_id: 'end-B' }),
      ],
      entregas: [
        { enderecoId: 'end-A', empresa_nome: 'Obra Norte', endereco: 'Rua A, 1' },
        { enderecoId: 'end-B', empresa_nome: 'Obra Sul', endereco: 'Rua B, 2' },
      ],
    });
    const entregas = pontos.filter((p) => p.tipo === 'entrega');
    expect(entregas).toHaveLength(2);
    const a = entregas.find((p) => p.endereco === 'Rua A, 1')!;
    const b = entregas.find((p) => p.endereco === 'Rua B, 2')!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.empresa_nome).toBe('Obra Norte');
    expect(b.empresa_nome).toBe('Obra Sul');
    expect(a.itens.map((i) => i.codigo)).toEqual(['E1']);
    expect(b.itens.map((i) => i.codigo)).toEqual(['E2']);
  });

  it('2 itens entrega no MESMO endereço → 1 ponto entrega com os 2 itens', () => {
    const pontos = sincronizarDestinos({
      itens: [
        item({ codigo: 'E1', modalidade: 'entrega', endereco_entrega_id: 'end-A' }),
        item({ codigo: 'E2', modalidade: 'entrega', endereco_entrega_id: 'end-A' }),
      ],
      entregas: [{ enderecoId: 'end-A', empresa_nome: 'Obra', endereco: 'Rua A, 1' }],
    });
    const entregas = pontos.filter((p) => p.tipo === 'entrega');
    expect(entregas).toHaveLength(1);
    expect(entregas[0].itens.map((i) => i.codigo)).toEqual(['E1', 'E2']);
  });

  it('itens entrega SEM endereço_entrega_id → caem no destino entrega padrão (input.entrega)', () => {
    const pontos = sincronizarDestinos({
      itens: [item({ codigo: 'E', modalidade: 'entrega' })],
      entrega: { empresa_nome: 'Cliente', endereco: 'Av. Padrão, 9' },
    });
    const entregas = pontos.filter((p) => p.tipo === 'entrega');
    expect(entregas).toHaveLength(1);
    expect(entregas[0].endereco).toBe('Av. Padrão, 9');
    expect(entregas[0].itens.map((i) => i.codigo)).toEqual(['E']);
  });

  it('mistura: 1 item no endereço padrão (null) + 1 item endereço B → 2 pontos entrega distintos', () => {
    const pontos = sincronizarDestinos({
      itens: [
        item({ codigo: 'E0', modalidade: 'entrega' }),
        item({ codigo: 'EB', modalidade: 'entrega', endereco_entrega_id: 'end-B' }),
      ],
      entrega: { empresa_nome: 'Cliente', endereco: 'Av. Padrão, 9' },
      entregas: [{ enderecoId: 'end-B', empresa_nome: 'Obra Sul', endereco: 'Rua B, 2' }],
    });
    const entregas = pontos.filter((p) => p.tipo === 'entrega');
    expect(entregas).toHaveLength(2);
    expect(entregas.find((p) => p.endereco === 'Av. Padrão, 9')!.itens.map((i) => i.codigo)).toEqual(['E0']);
    expect(entregas.find((p) => p.endereco === 'Rua B, 2')!.itens.map((i) => i.codigo)).toEqual(['EB']);
  });

  it('destino PADRÃO e um destino por-endereço com a MESMA PK → 1 ponto (sem PK duplicada)', () => {
    // Cenário do bug: editar um pedido que carregou com ≥2 pontos entrega. O destino
    // PADRÃO (input.entrega) herda a PK do 1º ponto (peA), e peA também está em
    // `entregas`. O operador manda um item pro "Padrão" (sem endereco_entrega_id) e
    // outro mantém o endereço peA. SEM o merge, sairiam 2 pontos com id='peA' →
    // a reconciliação faria 2 UPDATE no mesmo registro (perda de item).
    const pontos = sincronizarDestinos({
      itens: [
        item({ codigo: 'E_PADRAO', modalidade: 'entrega' }), // key=null → input.entrega (peA)
        item({ codigo: 'E_PEA', modalidade: 'entrega', endereco_entrega_id: 'peA' }), // key=peA
        item({ codigo: 'E_PEB', modalidade: 'entrega', endereco_entrega_id: 'peB' }),
      ],
      entrega: { id: 'peA', empresa_nome: 'Obra Norte', endereco: 'Rua A, 1' },
      entregas: [
        { id: 'peA', enderecoId: 'peA', empresa_nome: 'Obra Norte', endereco: 'Rua A, 1' },
        { id: 'peB', enderecoId: 'peB', empresa_nome: 'Obra Sul', endereco: 'Rua B, 2' },
      ],
    });
    const entregas = pontos.filter((p) => p.tipo === 'entrega');
    // Nenhuma PK aparece duas vezes.
    const ids = entregas.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // peA virou UM ponto só, com os itens dos dois buckets (padrão + endereço peA).
    const a = entregas.find((p) => p.id === 'peA')!;
    expect(a).toBeDefined();
    expect(a.itens.map((i) => i.codigo).sort()).toEqual(['E_PADRAO', 'E_PEA']);
    // peB intacto.
    const b = entregas.find((p) => p.id === 'peB')!;
    expect(b.itens.map((i) => i.codigo)).toEqual(['E_PEB']);
  });

  it('dois destinos NOVOS (ambos id=null) NÃO são fundidos', () => {
    // id=null = destino novo (ainda sem PK). Dois endereços novos distintos devem
    // continuar separados — o merge só colapsa PKs reais iguais.
    const pontos = sincronizarDestinos({
      itens: [
        item({ codigo: 'E1', modalidade: 'entrega', endereco_entrega_id: 'novo-A' }),
        item({ codigo: 'E2', modalidade: 'entrega', endereco_entrega_id: 'novo-B' }),
      ],
      entregas: [
        { id: null, enderecoId: 'novo-A', empresa_nome: 'A', endereco: 'Rua A' },
        { id: null, enderecoId: 'novo-B', empresa_nome: 'B', endereco: 'Rua B' },
      ],
    });
    const entregas = pontos.filter((p) => p.tipo === 'entrega');
    expect(entregas).toHaveLength(2);
    expect(entregas.every((p) => p.id == null)).toBe(true);
  });

  it('preserva a PK do ponto entrega por endereço (UPDATE in-place por destino)', () => {
    const pontos = sincronizarDestinos({
      itens: [
        item({ codigo: 'E1', modalidade: 'entrega', endereco_entrega_id: 'end-A' }),
        item({ codigo: 'E2', modalidade: 'entrega', endereco_entrega_id: 'end-B' }),
      ],
      entregas: [
        { id: 'ponto-A', enderecoId: 'end-A', endereco: 'Rua A, 1' },
        { id: 'ponto-B', enderecoId: 'end-B', endereco: 'Rua B, 2' },
      ],
    });
    const a = pontos.find((p) => p.endereco === 'Rua A, 1')!;
    const b = pontos.find((p) => p.endereco === 'Rua B, 2')!;
    expect(a.id).toBe('ponto-A');
    expect(b.id).toBe('ponto-B');
  });
});

describe('normalizarParaForm', () => {
  function ponto(over: Partial<PontoInput> = {}): PontoInput {
    return { tipo: 'loja', empresa_nome: '', endereco: null, itens: [], ...over };
  }

  it('pedido novo (1 ponto loja vazio) → loja com itens vazio + entrega placeholder', () => {
    const { loja, entrega } = normalizarParaForm([
      ponto({ tipo: 'loja', empresa_nome: 'Matriz' }),
    ]);
    expect(loja.empresa_nome).toBe('Matriz');
    expect(loja.itens).toEqual([]);
    expect(entrega.tipo).toBe('entrega');
    expect(entrega.itens).toEqual([]);
  });

  it('híbrido legado (loja+entrega) → todos os itens no ponto loja; destinos preservados', () => {
    const { loja, entrega } = normalizarParaForm([
      { id: 'pl', tipo: 'loja', empresa_nome: 'Loja', endereco: 'R1', itens: [item({ codigo: 'A', modalidade: 'loja' })] },
      { id: 'pe', tipo: 'entrega', empresa_nome: 'Cliente', endereco: 'R2', itens: [item({ codigo: 'B', modalidade: 'entrega' })] },
    ]);
    // todos os itens consolidados no ponto de trabalho loja
    expect(loja.itens.map((i) => i.codigo)).toEqual(['A', 'B']);
    expect(loja.id).toBe('pl');
    // o ponto entrega de trabalho guarda só o destino (sem itens) + sua PK
    expect(entrega.id).toBe('pe');
    expect(entrega.endereco).toBe('R2');
    expect(entrega.itens).toEqual([]);
  });

  it('depósito legado vira destino loja de trabalho (não é mais modalidade)', () => {
    const { loja } = normalizarParaForm([
      { tipo: 'deposito', empresa_nome: 'Depósito 1', endereco: null, itens: [item()] },
    ]);
    expect(loja.tipo).toBe('loja');
    expect(loja.empresa_nome).toBe('Depósito 1');
    expect(loja.itens).toHaveLength(1);
  });

  it('ponto imediato carregado → itens dobrados na tabela de trabalho (modalidade preservada)', () => {
    const { loja } = normalizarParaForm([
      { id: 'pi', tipo: 'imediato', empresa_nome: '', endereco: null, itens: [item({ codigo: 'I', modalidade: 'imediato' })] },
    ]);
    // O item imediato é recuperado (não some) e mantém sua modalidade.
    expect(loja.itens.map((i) => i.codigo)).toEqual(['I']);
    expect(loja.itens[0].modalidade).toBe('imediato');
  });

  it('round-trip: normalizar → sincronizar reconstrói os mesmos destinos', () => {
    const original: PontoInput[] = [
      { id: 'pl', tipo: 'loja', empresa_nome: 'Loja', endereco: 'R1', itens: [item({ codigo: 'A', modalidade: 'loja' })] },
      { id: 'pe', tipo: 'entrega', empresa_nome: 'Cliente', endereco: 'R2', itens: [item({ codigo: 'B', modalidade: 'entrega' })] },
    ];
    const { loja, entrega } = normalizarParaForm(original);
    const reconstruido = sincronizarDestinos({
      itens: loja.itens,
      loja: { id: loja.id, empresa_nome: loja.empresa_nome, endereco: loja.endereco },
      entrega: { id: entrega.id, empresa_nome: entrega.empresa_nome, endereco: entrega.endereco },
    });
    expect(reconstruido).toHaveLength(2);
    const l = reconstruido.find((p) => p.tipo === 'loja')!;
    const e = reconstruido.find((p) => p.tipo === 'entrega')!;
    expect(l.id).toBe('pl');
    expect(l.itens.map((i) => i.codigo)).toEqual(['A']);
    expect(e.id).toBe('pe');
    expect(e.endereco).toBe('R2');
    expect(e.itens.map((i) => i.codigo)).toEqual(['B']);
  });

  it('round-trip com imediato: item imediato sobrevive a normalizar → sincronizar (sem data loss)', () => {
    // Pedido carregado com 1 item loja + 1 item imediato (em pontos distintos).
    const original: PontoInput[] = [
      { id: 'pl', tipo: 'loja', empresa_nome: 'Loja', endereco: 'R1', itens: [item({ codigo: 'A', modalidade: 'loja' })] },
      { id: 'pi', tipo: 'imediato', empresa_nome: '', endereco: null, itens: [item({ codigo: 'I', modalidade: 'imediato' })] },
    ];
    const { loja, entrega } = normalizarParaForm(original);
    const reconstruido = sincronizarDestinos({
      itens: loja.itens,
      loja: { id: loja.id, empresa_nome: loja.empresa_nome, endereco: loja.endereco },
      entrega: { id: entrega.id, empresa_nome: entrega.empresa_nome, endereco: entrega.endereco },
    });
    // O item imediato continua presente (num ponto imediato) — NÃO foi descartado.
    const todosCodigos = reconstruido.flatMap((p) => p.itens.map((i) => i.codigo));
    expect(todosCodigos).toContain('I');
    const pontoImediato = reconstruido.find((p) => p.tipo === 'imediato')!;
    expect(pontoImediato).toBeDefined();
    expect(pontoImediato.itens.map((i) => i.codigo)).toEqual(['I']);
    expect(pontoImediato.itens[0].modalidade).toBe('imediato');
  });
});

describe('normalizarParaForm — multi-endereço de entrega (Task 10)', () => {
  it('carrega 2 pontos entrega → cada item entrega ganha endereco_entrega_id do seu ponto', () => {
    const { loja, entregas } = normalizarParaForm([
      { id: 'pl', tipo: 'loja', empresa_nome: 'Loja', endereco: 'R1', itens: [item({ codigo: 'A', modalidade: 'loja' })] },
      { id: 'peA', tipo: 'entrega', empresa_nome: 'Obra Norte', endereco: 'Rua A, 1', itens: [item({ codigo: 'EA', modalidade: 'entrega' })] },
      { id: 'peB', tipo: 'entrega', empresa_nome: 'Obra Sul', endereco: 'Rua B, 2', itens: [item({ codigo: 'EB', modalidade: 'entrega' })] },
    ]);
    // 2 destinos de entrega recuperados, cada um com sua PK + endereço
    expect(entregas).toHaveLength(2);
    expect(entregas.map((e) => e.id).sort()).toEqual(['peA', 'peB']);
    // cada item entrega leva o endereco_entrega_id do destino de onde veio
    const ea = loja.itens.find((i) => i.codigo === 'EA')!;
    const eb = loja.itens.find((i) => i.codigo === 'EB')!;
    expect(ea.endereco_entrega_id).toBeTruthy();
    expect(eb.endereco_entrega_id).toBeTruthy();
    expect(ea.endereco_entrega_id).not.toBe(eb.endereco_entrega_id);
    // o item loja NÃO ganha endereco_entrega_id
    const a = loja.itens.find((i) => i.codigo === 'A')!;
    expect(a.endereco_entrega_id ?? null).toBeNull();
  });

  it('round-trip multi-endereço: normalizar → sincronizar reconstrói os 2 destinos com os itens certos', () => {
    const original: PontoInput[] = [
      { id: 'peA', tipo: 'entrega', empresa_nome: 'Obra Norte', endereco: 'Rua A, 1', itens: [item({ codigo: 'EA', modalidade: 'entrega' })] },
      { id: 'peB', tipo: 'entrega', empresa_nome: 'Obra Sul', endereco: 'Rua B, 2', itens: [item({ codigo: 'EB', modalidade: 'entrega' })] },
    ];
    const { loja, entregas } = normalizarParaForm(original);
    const reconstruido = sincronizarDestinos({
      itens: loja.itens,
      loja: { id: loja.id, empresa_nome: loja.empresa_nome, endereco: loja.endereco },
      entregas: entregas.map((e) => ({
        id: e.id,
        enderecoId: e.endereco_entrega_id,
        empresa_nome: e.empresa_nome,
        endereco: e.endereco,
      })),
    });
    const ents = reconstruido.filter((p) => p.tipo === 'entrega');
    expect(ents).toHaveLength(2);
    const a = ents.find((p) => p.endereco === 'Rua A, 1')!;
    const b = ents.find((p) => p.endereco === 'Rua B, 2')!;
    expect(a.id).toBe('peA');
    expect(b.id).toBe('peB');
    expect(a.itens.map((i) => i.codigo)).toEqual(['EA']);
    expect(b.itens.map((i) => i.codigo)).toEqual(['EB']);
  });
});
