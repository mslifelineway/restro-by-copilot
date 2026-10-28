'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { ErrorBox, Loading } from '@/components/query-state';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import type { Outlet } from '@/lib/types';
import { useCan, useMe } from '@/lib/use-me';

type DailySales = {
  date: string;
  timezone: string;
  totals: {
    invoiceCount: number; grossSalesPaise: string; taxPaise: string;
    discountPaise: string; serviceChargePaise: string; tipPaise: string; roundOffPaise: string;
  };
  items: Array<{ itemName: string; categoryName: string; quantity: number; salesPaise: string }>;
  tax: Array<{ taxCode: string; cgstRate: number; sgstRate: number; igstRate: number; taxablePaise: string; cgstPaise: string; sgstPaise: string; igstPaise: string; taxPaise: string }>;
  payments: Array<{ method: string; netPaise: string }>;
  cashiers: Array<{ userId: string; cashierName: string; netSalesPaise: string }>;
};

function money(paise: string) {
  const amount = BigInt(paise);
  const absolute = amount < 0n ? -amount : amount;
  const rupees = absolute / 100n;
  const cents = String(absolute % 100n).padStart(2, '0');
  return `${amount < 0n ? '-₹' : '₹'}${rupees.toLocaleString('en-IN')}.${cents}`;
}

export default function ReportsPage() {
  const me = useMe();
  const canRead = useCan('report:read');
  const canSelectOutlet = useCan('outlet:read');
  const [outletId, setOutletId] = useState('');
  const [date, setDate] = useState('');
  const outlets = useQuery({ queryKey: ['outlets', 'all'], queryFn: () => api.list<Outlet>('/v1/outlets?page=1&limit=100'), enabled: canSelectOutlet });
  useEffect(() => {
    if (outletId) return;
    if (me.data?.kind === 'tenant' && me.data.outletId) setOutletId(me.data.outletId);
    else if (outlets.data?.items[0]) setOutletId(outlets.data.items[0].id);
  }, [outletId, me.data, outlets.data]);
  const headers = { 'x-outlet-id': outletId };
  const report = useQuery({
    queryKey: ['daily-sales-report', outletId, date],
    queryFn: () => api.get<DailySales>(`/v1/reports/daily-sales${date ? `?date=${encodeURIComponent(date)}` : ''}`, headers),
    enabled: !!outletId && canRead,
  });
  if (me.isLoading || (canSelectOutlet && outlets.isLoading) || (canRead && !!outletId && report.isLoading)) return <Loading />;
  if (me.isError) return <ErrorBox error={me.error} />;
  if (outlets.isError) return <ErrorBox error={outlets.error} />;
  if (report.isError) return <ErrorBox error={report.error} />;
  const data = report.data;
  return <div>
    <PageHeader title="Daily sales report" description="Review gross invoiced sales by item, category, tax, payment method, and cashier." />
    <div className="mb-5 grid gap-3 sm:grid-cols-2">
      {canSelectOutlet && outlets.data && <Field label="Outlet"><Select value={outletId} onChange={(event) => setOutletId(event.target.value)}><option value="">Choose outlet</option>{outlets.data.items.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</Select></Field>}
      <Field label="Business date"><Input type="date" value={date || data?.date || ''} onChange={(event) => setDate(event.target.value)} /></Field>
    </div>
    {!data ? <Card className="p-6 text-sm text-muted-foreground">Select an outlet to view its report.</Card> : <>
      <p className="mb-3 text-sm text-muted-foreground">Business date {data.date} · {data.timezone}. Invoice totals are gross of refunds; payment and cashier totals are net of refunds recorded that day.</p>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4"><p className="text-sm text-muted-foreground">Gross invoiced sales</p><p className="text-2xl font-semibold">{money(data.totals.grossSalesPaise)}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Invoices finalized</p><p className="text-2xl font-semibold">{data.totals.invoiceCount}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">GST on invoices</p><p className="text-2xl font-semibold">{money(data.totals.taxPaise)}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Discounts</p><p className="text-2xl font-semibold">{money(data.totals.discountPaise)}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Service charges</p><p className="text-2xl font-semibold">{money(data.totals.serviceChargePaise)}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Tips</p><p className="text-2xl font-semibold">{money(data.totals.tipPaise)}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Round-off total</p><p className="text-2xl font-semibold">{money(data.totals.roundOffPaise)}</p></Card>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="space-y-3 p-4"><h2 className="text-lg font-semibold">Sales by item & category</h2>
          <Table><thead><tr><Th>Item</Th><Th>Category</Th><Th>Qty</Th><Th>Sales</Th></tr></thead><tbody>
            {data.items.map((row, index) => <tr key={`${row.itemName}-${row.categoryName}-${index}`}><Td>{row.itemName}</Td><Td>{row.categoryName}</Td><Td>{row.quantity}</Td><Td>{money(row.salesPaise)}</Td></tr>)}
            {!data.items.length && <tr><Td colSpan={4} className="text-center text-muted-foreground">No invoices for this date.</Td></tr>}
          </tbody></Table>
        </Card>
        <Card className="space-y-3 p-4"><h2 className="text-lg font-semibold">Tax summary</h2>
          <Table><thead><tr><Th>Tax code</Th><Th>Taxable</Th><Th>CGST rate / tax</Th><Th>SGST rate / tax</Th><Th>IGST rate / tax</Th></tr></thead><tbody>
            {data.tax.map((row, index) => <tr key={`${row.taxCode}-${row.cgstRate}-${row.sgstRate}-${row.igstRate}-${index}`}><Td>{row.taxCode}</Td><Td>{money(row.taxablePaise)}</Td><Td>{(row.cgstRate / 100).toFixed(2)}% · {money(row.cgstPaise)}</Td><Td>{(row.sgstRate / 100).toFixed(2)}% · {money(row.sgstPaise)}</Td><Td>{(row.igstRate / 100).toFixed(2)}% · {money(row.igstPaise)}</Td></tr>)}
            {!data.tax.length && <tr><Td colSpan={5} className="text-center text-muted-foreground">No tax entries for this date.</Td></tr>}
          </tbody></Table>
        </Card>
        <Card className="space-y-3 p-4"><h2 className="text-lg font-semibold">Net payments by method</h2>
          <Table><thead><tr><Th>Method</Th><Th>Net received</Th></tr></thead><tbody>
            {data.payments.map((row) => <tr key={row.method}><Td>{row.method}</Td><Td>{money(row.netPaise)}</Td></tr>)}
            {!data.payments.length && <tr><Td colSpan={2} className="text-center text-muted-foreground">No payments for this date.</Td></tr>}
          </tbody></Table>
        </Card>
        <Card className="space-y-3 p-4"><h2 className="text-lg font-semibold">Net payments by cashier</h2>
          <Table><thead><tr><Th>Cashier</Th><Th>Net received</Th></tr></thead><tbody>
            {data.cashiers.map((row) => <tr key={row.userId}><Td>{row.cashierName}</Td><Td>{money(row.netSalesPaise)}</Td></tr>)}
            {!data.cashiers.length && <tr><Td colSpan={2} className="text-center text-muted-foreground">No cashier payments for this date.</Td></tr>}
          </tbody></Table>
        </Card>
      </div>
    </>}
  </div>;
}
