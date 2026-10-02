import { HomeEmpty } from '@/components/home-empty';

/**
 * The home screen. It renders the empty state and nothing else, and runs no group query:
 * there are no groups in this ticket, and a query for a table that does not exist is a 500.
 */
export default function HomePage() {
  return <HomeEmpty />;
}
