export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      cliente_enderecos: {
        Row: {
          bairro: string | null
          cep: string | null
          cidade: string | null
          cliente_id: string
          created_at: string
          empresa_id: string
          endereco: string | null
          id: string
          is_padrao: boolean
          rotulo: string
          telefone: string | null
          uf: string | null
          updated_at: string
        }
        Insert: {
          bairro?: string | null
          cep?: string | null
          cidade?: string | null
          cliente_id: string
          created_at?: string
          empresa_id?: string
          endereco?: string | null
          id?: string
          is_padrao?: boolean
          rotulo: string
          telefone?: string | null
          uf?: string | null
          updated_at?: string
        }
        Update: {
          bairro?: string | null
          cep?: string | null
          cidade?: string | null
          cliente_id?: string
          created_at?: string
          empresa_id?: string
          endereco?: string | null
          id?: string
          is_padrao?: boolean
          rotulo?: string
          telefone?: string | null
          uf?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cliente_enderecos_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "clientes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cliente_enderecos_empresa_id_fkey"
            columns: ["empresa_id"]
            isOneToOne: false
            referencedRelation: "empresas"
            referencedColumns: ["id"]
          },
        ]
      }
      clientes: {
        Row: {
          bairro_padrao: string | null
          cep_padrao: string | null
          cidade_padrao: string | null
          cnpj_cpf: string | null
          codigo_erp: string | null
          created_at: string
          empresa_id: string
          endereco_padrao: string | null
          id: string
          nome: string
          observacoes: string | null
          telefone_padrao: string | null
          uf_padrao: string | null
          updated_at: string
        }
        Insert: {
          bairro_padrao?: string | null
          cep_padrao?: string | null
          cidade_padrao?: string | null
          cnpj_cpf?: string | null
          codigo_erp?: string | null
          created_at?: string
          empresa_id?: string
          endereco_padrao?: string | null
          id?: string
          nome: string
          observacoes?: string | null
          telefone_padrao?: string | null
          uf_padrao?: string | null
          updated_at?: string
        }
        Update: {
          bairro_padrao?: string | null
          cep_padrao?: string | null
          cidade_padrao?: string | null
          cnpj_cpf?: string | null
          codigo_erp?: string | null
          created_at?: string
          empresa_id?: string
          endereco_padrao?: string | null
          id?: string
          nome?: string
          observacoes?: string | null
          telefone_padrao?: string | null
          uf_padrao?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clientes_empresa_id_fkey"
            columns: ["empresa_id"]
            isOneToOne: false
            referencedRelation: "empresas"
            referencedColumns: ["id"]
          },
        ]
      }
      dispositivos: {
        Row: {
          ativo: boolean
          created_at: string
          empresa_id: string
          id: string
          last_seen_at: string | null
          nome: string
          token_hash: string
        }
        Insert: {
          ativo?: boolean
          created_at?: string
          empresa_id: string
          id?: string
          last_seen_at?: string | null
          nome: string
          token_hash: string
        }
        Update: {
          ativo?: boolean
          created_at?: string
          empresa_id?: string
          id?: string
          last_seen_at?: string | null
          nome?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "dispositivos_empresa_id_fkey"
            columns: ["empresa_id"]
            isOneToOne: false
            referencedRelation: "empresas"
            referencedColumns: ["id"]
          },
        ]
      }
      empresas: {
        Row: {
          ativo: boolean
          cor_primaria: string | null
          created_at: string
          id: string
          logo_url: string | null
          nome: string
          slug: string
          updated_at: string
        }
        Insert: {
          ativo?: boolean
          cor_primaria?: string | null
          created_at?: string
          id?: string
          logo_url?: string | null
          nome: string
          slug: string
          updated_at?: string
        }
        Update: {
          ativo?: boolean
          cor_primaria?: string | null
          created_at?: string
          id?: string
          logo_url?: string | null
          nome?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      pedido_comentarios: {
        Row: {
          autor_id: string | null
          created_at: string
          id: string
          pedido_id: string
          texto: string
        }
        Insert: {
          autor_id?: string | null
          created_at?: string
          id?: string
          pedido_id: string
          texto: string
        }
        Update: {
          autor_id?: string | null
          created_at?: string
          id?: string
          pedido_id?: string
          texto?: string
        }
        Relationships: [
          {
            foreignKeyName: "pedido_comentarios_autor_id_fkey"
            columns: ["autor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_comentarios_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "pedidos"
            referencedColumns: ["id"]
          },
        ]
      }
      pedido_eventos: {
        Row: {
          created_at: string
          descricao: string | null
          id: string
          payload: Json | null
          pedido_id: string
          tipo: string
          usuario_id: string | null
        }
        Insert: {
          created_at?: string
          descricao?: string | null
          id?: string
          payload?: Json | null
          pedido_id: string
          tipo: string
          usuario_id?: string | null
        }
        Update: {
          created_at?: string
          descricao?: string | null
          id?: string
          payload?: Json | null
          pedido_id?: string
          tipo?: string
          usuario_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pedido_eventos_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "pedidos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_eventos_usuario_id_fkey"
            columns: ["usuario_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pedido_itens: {
        Row: {
          codigo: string
          created_at: string
          desconto: number
          descricao: string
          endereco_estoque: string | null
          id: string
          lote: string | null
          ordem: number
          peso_bruto: number | null
          peso_liquido: number | null
          ponto_retirada_id: string
          preco_unitario: number
          quantidade: number
          quantidade_entregue: number
          referencia: string | null
          total: number
          unidade: string
        }
        Insert: {
          codigo?: string
          created_at?: string
          desconto?: number
          descricao?: string
          endereco_estoque?: string | null
          id?: string
          lote?: string | null
          ordem?: number
          peso_bruto?: number | null
          peso_liquido?: number | null
          ponto_retirada_id: string
          preco_unitario?: number
          quantidade?: number
          quantidade_entregue?: number
          referencia?: string | null
          total?: number
          unidade?: string
        }
        Update: {
          codigo?: string
          created_at?: string
          desconto?: number
          descricao?: string
          endereco_estoque?: string | null
          id?: string
          lote?: string | null
          ordem?: number
          peso_bruto?: number | null
          peso_liquido?: number | null
          ponto_retirada_id?: string
          preco_unitario?: number
          quantidade?: number
          quantidade_entregue?: number
          referencia?: string | null
          total?: number
          unidade?: string
        }
        Relationships: [
          {
            foreignKeyName: "pedido_itens_ponto_retirada_id_fkey"
            columns: ["ponto_retirada_id"]
            isOneToOne: false
            referencedRelation: "pedido_pontos_retirada"
            referencedColumns: ["id"]
          },
        ]
      }
      pedido_logistica: {
        Row: {
          conferente: string | null
          km_final: number | null
          km_inicial: number | null
          motorista: string | null
          observacoes: string | null
          pedido_id: string
          peso_bruto_total: number | null
          peso_liquido_total: number | null
          pre_carga: string | null
          regiao: string | null
          updated_at: string
          updated_by: string | null
          veiculo: string | null
        }
        Insert: {
          conferente?: string | null
          km_final?: number | null
          km_inicial?: number | null
          motorista?: string | null
          observacoes?: string | null
          pedido_id: string
          peso_bruto_total?: number | null
          peso_liquido_total?: number | null
          pre_carga?: string | null
          regiao?: string | null
          updated_at?: string
          updated_by?: string | null
          veiculo?: string | null
        }
        Update: {
          conferente?: string | null
          km_final?: number | null
          km_inicial?: number | null
          motorista?: string | null
          observacoes?: string | null
          pedido_id?: string
          peso_bruto_total?: number | null
          peso_liquido_total?: number | null
          pre_carga?: string | null
          regiao?: string | null
          updated_at?: string
          updated_by?: string | null
          veiculo?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pedido_logistica_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: true
            referencedRelation: "pedidos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_logistica_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pedido_pontos_retirada: {
        Row: {
          created_at: string
          empresa_nome: string
          endereco: string | null
          id: string
          ordem: number
          pedido_id: string
          tipo: Database["public"]["Enums"]["ponto_retirada_tipo"]
        }
        Insert: {
          created_at?: string
          empresa_nome?: string
          endereco?: string | null
          id?: string
          ordem?: number
          pedido_id: string
          tipo?: Database["public"]["Enums"]["ponto_retirada_tipo"]
        }
        Update: {
          created_at?: string
          empresa_nome?: string
          endereco?: string | null
          id?: string
          ordem?: number
          pedido_id?: string
          tipo?: Database["public"]["Enums"]["ponto_retirada_tipo"]
        }
        Relationships: [
          {
            foreignKeyName: "pedido_pontos_retirada_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "pedidos"
            referencedColumns: ["id"]
          },
        ]
      }
      pedidos: {
        Row: {
          cliente_bairro: string | null
          cliente_cep: string | null
          cliente_cidade: string | null
          cliente_cnpj_cpf: string | null
          cliente_codigo: string | null
          cliente_endereco: string | null
          cliente_endereco_id: string | null
          cliente_id: string | null
          cliente_nome: string
          cliente_telefone: string | null
          cliente_uf: string | null
          created_at: string
          data_emissao: string | null
          data_entrega: string | null
          documento_erp: string | null
          empresa_id: string
          forma_pagamento: string | null
          id: string
          numero_mapa: number
          observacoes: string | null
          parcelas: string | null
          status: Database["public"]["Enums"]["pedido_status"]
          storage_pdf_path: string | null
          updated_at: string
          valor_total: number
          vendedor_id: string | null
        }
        Insert: {
          cliente_bairro?: string | null
          cliente_cep?: string | null
          cliente_cidade?: string | null
          cliente_cnpj_cpf?: string | null
          cliente_codigo?: string | null
          cliente_endereco?: string | null
          cliente_endereco_id?: string | null
          cliente_id?: string | null
          cliente_nome?: string
          cliente_telefone?: string | null
          cliente_uf?: string | null
          created_at?: string
          data_emissao?: string | null
          data_entrega?: string | null
          documento_erp?: string | null
          empresa_id?: string
          forma_pagamento?: string | null
          id?: string
          numero_mapa?: number
          observacoes?: string | null
          parcelas?: string | null
          status?: Database["public"]["Enums"]["pedido_status"]
          storage_pdf_path?: string | null
          updated_at?: string
          valor_total?: number
          vendedor_id?: string | null
        }
        Update: {
          cliente_bairro?: string | null
          cliente_cep?: string | null
          cliente_cidade?: string | null
          cliente_cnpj_cpf?: string | null
          cliente_codigo?: string | null
          cliente_endereco?: string | null
          cliente_endereco_id?: string | null
          cliente_id?: string | null
          cliente_nome?: string
          cliente_telefone?: string | null
          cliente_uf?: string | null
          created_at?: string
          data_emissao?: string | null
          data_entrega?: string | null
          documento_erp?: string | null
          empresa_id?: string
          forma_pagamento?: string | null
          id?: string
          numero_mapa?: number
          observacoes?: string | null
          parcelas?: string | null
          status?: Database["public"]["Enums"]["pedido_status"]
          storage_pdf_path?: string | null
          updated_at?: string
          valor_total?: number
          vendedor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pedidos_cliente_endereco_id_fkey"
            columns: ["cliente_endereco_id"]
            isOneToOne: false
            referencedRelation: "cliente_enderecos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedidos_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "clientes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedidos_empresa_id_fkey"
            columns: ["empresa_id"]
            isOneToOne: false
            referencedRelation: "empresas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedidos_vendedor_id_fkey"
            columns: ["vendedor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          empresa_id: string | null
          full_name: string
          id: string
          is_platform_admin: boolean
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          empresa_id?: string | null
          full_name?: string
          id: string
          is_platform_admin?: boolean
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          empresa_id?: string | null
          full_name?: string
          id?: string
          is_platform_admin?: boolean
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_empresa_id_fkey"
            columns: ["empresa_id"]
            isOneToOne: false
            referencedRelation: "empresas"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_empresa_id: { Args: never; Returns: string }
      current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      is_platform_admin: { Args: never; Returns: boolean }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      unaccent: { Args: { "": string }; Returns: string }
    }
    Enums: {
      pedido_status:
        | "rascunho"
        | "pendente"
        | "em_separacao"
        | "finalizado"
        | "cancelado"
        | "parcialmente_entregue"
      ponto_retirada_tipo: "loja" | "deposito"
      user_role: "admin" | "vendedor" | "logistica"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      pedido_status: [
        "rascunho",
        "pendente",
        "em_separacao",
        "finalizado",
        "cancelado",
        "parcialmente_entregue",
      ],
      ponto_retirada_tipo: ["loja", "deposito"],
      user_role: ["admin", "vendedor", "logistica"],
    },
  },
} as const
