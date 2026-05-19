"""
Gera PDF de teste com 1 item de quantidade=10 — permite testar entrega parcial.
"""
import sys
from datetime import datetime
from reportlab.pdfgen import canvas

out_path = sys.argv[1]
doc_id   = sys.argv[2] if len(sys.argv) > 2 else f"QA-{int(datetime.now().timestamp())}"

c = canvas.Canvas(out_path)
c.setFont("Helvetica-Bold", 14)
c.drawString(180, 800, "AMY TESTE QA")
c.setFont("Helvetica", 10)
c.drawString(150, 780, "AVENIDA MINAS GERAIS, 344")
c.drawString(150, 768, "LADO ÍMPAR - CAMARGO - 38304014 - ITUIUTABA - MG")
c.drawString(150, 756, "CNPJ: 86.127.344/0001-81 - FONE: 43 9609-7384")
c.setFont("Helvetica-Bold", 11)
c.drawString(120, 730, f"DOCUMENTO AUXILIAR DE VENDA - PEDIDO DE VENDA - N. {doc_id}")
c.setFont("Helvetica", 9)
c.drawString(80, 700, "Data de emissão: 14/05/2026 16:18    Data de entrega: 14/05/2026 até 14/05/2026")
c.drawString(80, 686, f"Número do documento: {doc_id}")
c.setFont("Helvetica-Bold", 10)
c.drawString(80, 660, "Identificação do destinatário")
c.setFont("Helvetica", 9)
c.drawString(80, 644, "Cliente 999 - QA PARCIAL TEST LTDA (00.000.000/0001-00)")
c.drawString(80, 630, "Endereço: Rua Playwright, 1 - - Bairro Parcial")
c.drawString(80, 616, "CEP: 88000-000 - SÃO JOSÉ - SC")
c.drawString(80, 602, "Telefone: (48) 9999-9999")
c.setFont("Helvetica-Bold", 9)
c.drawString(80, 570, "Produto                                  Quantidade Unitário Desconto Total")
c.setFont("Helvetica", 9)
c.drawString(80, 556, "9001 AREIA MÉDIA QA PARCIAL - 10 TN 100,00 0,00 1000,00")
c.drawString(80, 542, " Diversos (Ref. )")
c.drawString(80, 510, "Meios de pagamento     Parcelas     Vencimento     Valor")
c.setFont("Helvetica-Bold", 9)
c.drawString(80, 488, "Total 1000,00")
c.setFont("Helvetica", 9)
c.drawString(80, 470, "Forma de Pagamento: ENTREGA A RECEBER 1x")
c.drawString(80, 456, "Observação: PEDIDO DE TESTE QA PARCIAL — IGNORAR / CANCELAR")
c.drawString(80, 430, "É vedada a autenticação deste documento")
c.save()
print(out_path)
