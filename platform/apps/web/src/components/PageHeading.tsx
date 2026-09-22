import { Typography } from 'antd';

export function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="page-heading compact">
      <div><Typography.Title level={2}>{title}</Typography.Title><Typography.Text type="secondary">{description}</Typography.Text></div>
    </div>
  );
}

