import { searchPricebook } from '../db/pricebook.js';
import type { InboundCallRow, RetellFunctionResult } from '../types.js';

export async function handleGetPricebookItems(
  session: InboundCallRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const searchTerm = (args.search_term as string | undefined) ?? '';

  const items = await searchPricebook(session.tenantId, searchTerm, 10);

  if (items.length === 0) {
    return {
      result: JSON.stringify({
        status: 'no_results',
        message: `No pricebook items found matching "${searchTerm}".`,
      }),
    };
  }

  return {
    result: JSON.stringify({
      status: 'ok',
      items: items.map(item => ({
        productId: item.productId,
        name: item.name,
        description: item.description,
        unitPrice: item.unitPrice,
        taxable: item.taxable,
      })),
    }),
  };
}
