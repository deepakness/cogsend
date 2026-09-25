/** A typed application failure that HTTP and MCP adapters can map independently. */
export class ApiOperationError extends Error {
	constructor(
		message: string,
		readonly status = 400,
		readonly details?: Record<string, unknown>
	) {
		super(message);
		this.name = 'ApiOperationError';
	}
}
