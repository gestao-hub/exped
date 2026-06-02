export type SomId = 'sino' | 'bipe' | 'alarme';

export interface PreferenciasAviso {
  /** Master: avisos ligados (precisa do gesto de ativação no browser). */
  ativado: boolean;
  /** Tocar som no aviso. */
  som: boolean;
  /** Qual som. */
  somId: SomId;
  /** Repetir o som até reconhecer. */
  repetir: boolean;
  /** Mostrar notificação do Windows. */
  notificacao: boolean;
}

export const PREFERENCIAS_PADRAO: PreferenciasAviso = {
  ativado: false,
  som: true,
  somId: 'sino',
  repetir: true,
  notificacao: true,
};

const SONS_VALIDOS: SomId[] = ['sino', 'bipe', 'alarme'];

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Mescla um objeto desconhecido (JSON parseado) sobre os defaults, validando tipos. */
export function mesclarPreferencias(parcial: unknown): PreferenciasAviso {
  const p = (parcial && typeof parcial === 'object' ? parcial : {}) as Record<string, unknown>;
  const somId = SONS_VALIDOS.includes(p.somId as SomId)
    ? (p.somId as SomId)
    : PREFERENCIAS_PADRAO.somId;
  return {
    ativado: bool(p.ativado, PREFERENCIAS_PADRAO.ativado),
    som: bool(p.som, PREFERENCIAS_PADRAO.som),
    somId,
    repetir: bool(p.repetir, PREFERENCIAS_PADRAO.repetir),
    notificacao: bool(p.notificacao, PREFERENCIAS_PADRAO.notificacao),
  };
}

export function chaveStorage(userId: string): string {
  return `exped:avisos:${userId}`;
}

export function carregar(
  userId: string,
  storage: StorageLike | undefined = globalThis.localStorage,
): PreferenciasAviso {
  try {
    const raw = storage?.getItem(chaveStorage(userId));
    if (!raw) return { ...PREFERENCIAS_PADRAO };
    return mesclarPreferencias(JSON.parse(raw));
  } catch {
    return { ...PREFERENCIAS_PADRAO };
  }
}

export function salvar(
  userId: string,
  prefs: PreferenciasAviso,
  storage: StorageLike | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(chaveStorage(userId), JSON.stringify(prefs));
  } catch {
    /* localStorage indisponível — silencia */
  }
}
