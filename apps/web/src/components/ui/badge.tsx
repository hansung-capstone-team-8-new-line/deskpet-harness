import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

// shadcn/ui Badge. 상태는 항상 텍스트를 함께 쓴다 (색상만으로 구분하지 않음).
const badgeVariants = cva('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap', {
  variants: {
    variant: {
      neutral: 'border-border bg-muted text-foreground',
      outline: 'border-input bg-background text-foreground',
      destructive: 'border-destructive/40 bg-background text-destructive',
      warning: 'border-warning/40 bg-background text-warning',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

export function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
