import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  InboxOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Statistic,
  Table,
  Tag,
  message,
} from "antd";
import { useParams } from "react-router-dom";

import { api } from "../api/client";
import { PageHeading } from "../components/PageHeading";

interface ServiceStatus {
  role: "owner" | "member";
  pending: number;
  processing: number;
  failed: number;
  processedLastMinute: number;
  acceptedLastMinute: number;
  deadLetters: number;
  accepted: number;
  duplicate: number;
  rejected: number;
  recentDeadLetters: Array<{
    id: string;
    eventId: string;
    attempts: number;
    error: string;
    failedAt: string;
  }>;
}

export function ServiceStatusPage() {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const status = useQuery({
    queryKey: ["service-status", projectId],
    queryFn: () =>
      api<ServiceStatus>(
        `/api/v1/projects/${projectId}/analytics/service-status`,
      ),
    refetchInterval: 15_000,
  });
  const retry = useMutation({
    mutationFn: (taskId: string) =>
      api(`/api/v1/projects/${projectId}/dead-letters/${taskId}/retry`, {
        method: "POST",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["service-status", projectId],
      });
      messageApi.success("失败任务已重新放回 Outbox");
    },
  });
  const data = status.data;
  const unhealthy = (data?.failed ?? 0) > 0 || (data?.deadLetters ?? 0) > 0;
  const queueRows = data
    ? [
        { status: "pending", count: data.pending },
        { status: "processing", count: data.processing },
        { status: "failed", count: data.failed },
        { status: "dead-letter", count: data.deadLetters },
      ]
    : [];

  return (
    <>
      {contextHolder}
      <PageHeading
        title="服务状态"
        description="采集接收、Outbox 积压和 Worker 失败情况，每 15 秒刷新。"
      />
      <Alert
        type={unhealthy ? "warning" : "success"}
        showIcon
        message={
          unhealthy
            ? "存在待处理失败任务，请检查 Worker 日志或重新执行死信。"
            : "采集与处理链路运行正常。"
        }
      />
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} sm={12} xl={4}>
          <Card>
            <Statistic
              title="最近一分钟接收"
              value={data?.acceptedLastMinute ?? 0}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <Card>
            <Statistic
              title="最近一分钟处理"
              value={data?.processedLastMinute ?? 0}
              prefix={<ClockCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <Card>
            <Statistic
              title="累计接收"
              value={data?.accepted ?? 0}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <Card>
            <Statistic
              title="重复事件"
              value={data?.duplicate ?? 0}
              prefix={<InboxOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <Card>
            <Statistic
              title="拒绝事件"
              value={data?.rejected ?? 0}
              prefix={<CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <Card>
            <Statistic
              title="Outbox 待处理"
              value={data?.pending ?? 0}
              prefix={<InboxOutlined />}
            />
          </Card>
        </Col>
        <Col span={24}>
          <Card title="Outbox 状态">
            <Table
              loading={status.isLoading}
              pagination={false}
              rowKey="status"
              dataSource={queueRows}
              columns={[
                {
                  title: "状态",
                  dataIndex: "status",
                  render: (value: string) => (
                    <Tag
                      color={
                        value === "failed" || value === "dead-letter"
                          ? "red"
                          : value === "processing"
                            ? "blue"
                            : "default"
                      }
                    >
                      {value}
                    </Tag>
                  ),
                },
                { title: "任务数", dataIndex: "count" },
              ]}
            />
          </Card>
        </Col>
        <Col span={24}>
          <Card title="最近失败任务">
            <Table
              loading={status.isLoading}
              pagination={false}
              rowKey="id"
              dataSource={data?.recentDeadLetters ?? []}
              columns={[
                { title: "事件 ID", dataIndex: "eventId" },
                { title: "尝试次数", dataIndex: "attempts", width: 110 },
                {
                  title: "失败时间",
                  dataIndex: "failedAt",
                  width: 190,
                  render: (value: string) => new Date(value).toLocaleString(),
                },
                { title: "错误", dataIndex: "error", ellipsis: true },
                {
                  title: "操作",
                  key: "action",
                  width: 100,
                  render: (
                    _: unknown,
                    row: ServiceStatus["recentDeadLetters"][number],
                  ) =>
                    data?.role === "owner" ? (
                      <Button
                        size="small"
                        loading={retry.isPending && retry.variables === row.id}
                        onClick={() => retry.mutate(row.id)}
                      >
                        重试
                      </Button>
                    ) : null,
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}
