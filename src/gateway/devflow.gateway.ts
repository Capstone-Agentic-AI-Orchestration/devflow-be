import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

interface SubscribePayload {
  projectId: string;
}

interface StatusPayload {
  projectId: string;
  status: string;
  currentNode: string;
  error: string | null;
}

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/devflow',
})
export class DevFlowGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(DevFlowGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Client subscribes to status updates for a given projectId.
   * Emits `{ event: 'subscribe', data: { projectId } }` from the client side.
   * The client is joined to a Socket.IO room named after the projectId so only
   * that client (and any others monitoring the same project) receive events.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @MessageBody() data: SubscribePayload,
    @ConnectedSocket() client: Socket,
  ): void {
    const { projectId } = data;
    if (!projectId) {
      this.logger.warn(`Client ${client.id} sent subscribe without projectId`);
      return;
    }
    void client.join(projectId);
    this.logger.log(`Client ${client.id} subscribed to project ${projectId}`);
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @MessageBody() data: SubscribePayload,
    @ConnectedSocket() client: Socket,
  ): void {
    const { projectId } = data;
    if (!projectId) return;
    void client.leave(projectId);
    this.logger.log(`Client ${client.id} unsubscribed from project ${projectId}`);
  }

  /**
   * Called by OrchestrationService at each status transition.
   * Broadcasts a `project:status` event to all clients in the projectId room.
   */
  emitStatusUpdate(
    projectId: string,
    status: string,
    currentNode: string,
    error: string | null = null,
  ): void {
    const payload: StatusPayload = { projectId, status, currentNode, error };
    this.server.to(projectId).emit('project:status', payload);
    this.logger.log(
      `Emitted project:status to room ${projectId}: status=${status} node=${currentNode}`,
    );
  }
}
