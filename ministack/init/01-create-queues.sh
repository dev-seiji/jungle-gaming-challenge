#!/bin/sh
# Roda dentro do MiniStack quando ele fica pronto (pasta ready.d).
set -e

# O aws-cli v1 da imagem ignora a variável AWS_ENDPOINT_URL e iria para a AWS real;
# por isso o endpoint é passado explicitamente em todo comando.
sqs() { aws --endpoint-url "$AWS_ENDPOINT_URL" sqs "$@"; }

# A DLQ é criada primeiro porque a fila principal precisa do ARN dela.
# Fila FIFO exige que a DLQ também seja FIFO.
DLQ_URL=$(sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true --query QueueUrl --output text)
DLQ_ARN=$(sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

# maxReceiveCount=5: depois de 5 entregas sem ack, a mensagem vai para a DLQ.
# Valor provisório; a justificativa final fica para a Fase 6 (consumidor).
sqs create-queue --queue-name wager-transactions.fifo --attributes "{
  \"FifoQueue\": \"true\",
  \"VisibilityTimeout\": \"30\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
}" > /dev/null

echo "queues created"
