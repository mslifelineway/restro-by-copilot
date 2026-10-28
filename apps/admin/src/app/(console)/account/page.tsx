'use client';
import { ChangePasswordCard } from '@/components/change-password-card';
import { PageHeader } from '@/components/page-header';

export default function AccountPage() {
  return (
    <>
      <PageHeader title="Account" description="Manage the password for your platform admin account." />
      <ChangePasswordCard />
    </>
  );
}
