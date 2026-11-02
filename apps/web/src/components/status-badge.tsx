import { Badge } from '@/components/ui/badge';
import { STATUS_LABEL, type StatusKey } from '@/lib/model';

// 텍스트 + 모양(테두리·글자색)으로 구분한다. 색만으로 의미를 전달하지 않는다.
const VARIANT: Record<StatusKey, 'neutral' | 'outline' | 'destructive' | 'warning'> = {
  awaiting: 'outline',
  in_progress: 'outline',
  pending_assessment: 'warning',
  unknown: 'warning',
  failed: 'destructive',
  succeeded: 'neutral',
  cancelled: 'neutral',
};

export function StatusBadge({ status }: { status: StatusKey }) {
  return <Badge variant={VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}
