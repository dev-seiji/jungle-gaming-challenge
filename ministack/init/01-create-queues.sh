#!/bin/sh
# Roda dentro do MiniStack quando ele fica pronto (pasta ready.d).
set -e

# O aws-cli v1 da imagem ignora a variável AWS_ENDPOINT_URL e iria para a AWS real;
# por isso o endpoint é passado explicitamente em todo comando.
sqs() { aws --endpoint-url "$AWS_ENDPOINT_URL" sqs "$@"; }

create_queues() {
  # A DLQ é criada primeiro porque a fila principal precisa do ARN dela.
  # Fila FIFO exige que a DLQ também seja FIFO.
  DLQ_URL=$(sqs create-queue --queue-name wager-transactions-dlq.fifo \
    --attributes FifoQueue=true --query QueueUrl --output text)
  DLQ_ARN=$(sqs get-queue-attributes --queue-url "$DLQ_URL" \
    --attribute-names QueueArn --query Attributes.QueueArn --output text)

  # maxReceiveCount=5: depois de 5 entregas sem ack, a mensagem vai para a DLQ
  # (justificativa do limite no ARCHITECTURE.md, seção 11).
  sqs create-queue --queue-name wager-transactions.fifo --attributes "{
    \"FifoQueue\": \"true\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }" > /dev/null

  # Fila de SAÍDA: eventos de integração publicados pela outbox. Separada da fila de entrada (comandos),
  # senão o serviço consumiria a própria saída.
  sqs create-queue --queue-name wallet-events.fifo --attributes FifoQueue=true > /dev/null
}

# No MiniStack, uma access key de 12 dígitos vira uma conta AWS isolada (filas próprias, mesmos nomes).
# Conta 111111111111: usada pelos testes. Conta padrão (000000000000, chave "test"): usada pelo app.
# A conta do app por ÚLTIMO: o healthcheck do compose espera a última fila dela, então "healthy" = tudo pronto.
AWS_ACCESS_KEY_ID=111111111111 create_queues
AWS_ACCESS_KEY_ID=test create_queues

echo "queues created"
