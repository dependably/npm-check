import { debounce } from 'lodash';
import { helper } from '@fixture/utils';

export function Button(): { onClick: () => void } {
  return { onClick: debounce(() => helper('click'), 100) };
}
